//! One immutable archive intent supplies both recovery claims and worker paths.
//!
//! Output-name selection probes the filesystem, so it stays in the command and
//! its result is handed to the plan. Everything here is pure: admission,
//! execution and refresh therefore cannot disagree about which paths an
//! archive operation owns.
use crate::error::AppError;
use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

/// Bounds the request before any filesystem probe. Admission has its own
/// aggregate claim budget; this only rejects absurd input earlier and cheaper.
const MAX_SOURCES: usize = 32_768;
const MAX_PATH_BYTES: usize = 8 * 1024 * 1024;

fn validate(path: &str) -> Result<PathBuf, AppError> {
    let native = Path::new(path);
    if path.len() > 128 * 1024
        || path.contains('\0')
        || !native.is_absolute()
        || native.file_name().is_none()
        || native
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(AppError::InvalidPath(format!(
            "Archive requires bounded absolute non-root paths without traversal or NUL bytes: {path}"
        )));
    }
    Ok(PathBuf::from(path))
}

fn parent_of(path: &Path) -> Result<PathBuf, AppError> {
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::InvalidPath("Cannot determine parent directory".into()))
}

/// A validated compress request whose output name has not been chosen yet.
pub(crate) struct CompressRequest {
    sources: Vec<PathBuf>,
    parent: PathBuf,
    base_name: String,
}

impl CompressRequest {
    pub(crate) fn new(paths: Vec<String>) -> Result<Self, AppError> {
        if paths.is_empty() {
            return Err(AppError::Other("No paths provided".into()));
        }
        if paths.len() > MAX_SOURCES
            || paths
                .iter()
                .try_fold(0usize, |size, path| size.checked_add(path.len()))
                .is_none_or(|size| size > MAX_PATH_BYTES)
        {
            return Err(AppError::InvalidPath(
                "Archive selection exceeds its path count or size limit".into(),
            ));
        }
        let mut seen = HashSet::new();
        let mut sources = Vec::with_capacity(paths.len());
        // Repeated selections would claim the same resource twice and add the
        // same zip entry twice. Nesting stays legal: it is a read of a read.
        for path in &paths {
            let native = validate(path)?;
            if seen.insert(native.clone()) {
                sources.push(native);
            }
        }
        let first = &sources[0];
        let parent = parent_of(first)?;
        // The output is named after the selection, exactly as before.
        let base_name = if sources.len() == 1 {
            first
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Archive".to_owned())
        } else {
            "Archive".to_owned()
        };
        Ok(Self {
            sources,
            parent,
            base_name,
        })
    }

    pub(crate) fn parent(&self) -> &Path {
        &self.parent
    }

    pub(crate) fn base_name(&self) -> &str {
        &self.base_name
    }

    /// `output` comes from the command's unique-name probe under `parent()`.
    pub(crate) fn plan(self, output: PathBuf) -> ArchivePlan {
        ArchivePlan {
            output,
            request: Request::Compress {
                sources: self.sources,
            },
            presentation: None,
        }
    }
}

/// A validated extract request whose destination has not been chosen yet.
pub(crate) struct ExtractRequest {
    archive: PathBuf,
    parent: PathBuf,
    folder_name: String,
}

impl ExtractRequest {
    pub(crate) fn new(path: String) -> Result<Self, AppError> {
        let archive = validate(&path)?;
        let parent = parent_of(&archive)?;
        let folder_name = archive
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| "extracted".to_owned());
        Ok(Self {
            archive,
            parent,
            folder_name,
        })
    }

    pub(crate) fn parent(&self) -> &Path {
        &self.parent
    }

    pub(crate) fn folder_name(&self) -> &str {
        &self.folder_name
    }

    /// Extract-here writes the archive's own entry names straight into the
    /// containing directory, so the whole directory is the owned resource.
    pub(crate) fn here(self) -> ArchivePlan {
        let output = self.parent.clone();
        self.into_plan(output, true)
    }

    /// `output` comes from the command's unique-name probe under `parent()`.
    pub(crate) fn into_folder(self, output: PathBuf) -> ArchivePlan {
        self.into_plan(output, false)
    }

    fn into_plan(self, output: PathBuf, here: bool) -> ArchivePlan {
        ArchivePlan {
            output,
            request: Request::Extract {
                archive: self.archive,
                here,
            },
            presentation: None,
        }
    }
}

pub(crate) enum Request {
    Compress {
        sources: Vec<PathBuf>,
    },
    Extract {
        archive: PathBuf,
        /// Extract into `output` itself rather than creating it first.
        here: bool,
    },
}

/// An admitted archive operation: one owned public output plus its inputs.
pub(crate) struct ArchivePlan {
    output: PathBuf,
    request: Request,
    /// Requested spelling of `output`, retained once admission rebinds it.
    presentation: Option<PathBuf>,
}

impl ArchivePlan {
    /// The path the worker writes: admission's resolved spelling once bound.
    pub(crate) fn output(&self) -> &Path {
        &self.output
    }

    /// The spelling to report back to the renderer. Effect identity is the
    /// resolved path, but the caller reached this directory through its own
    /// spelling and derives its refresh broadcast from what we return; a
    /// physical path would leave windows on an alias unrefreshed. Native
    /// publication covers both parents through `affected_dirs`.
    pub(crate) fn presented_output(&self) -> &Path {
        self.presentation.as_deref().unwrap_or(&self.output)
    }

    pub(crate) fn request(&self) -> &Request {
        &self.request
    }

    /// The directories whose listings change. Extract publishes the archive's
    /// own directory and the destination; extract-here collapses to one.
    pub(crate) fn affected_dirs(&self) -> Vec<String> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        match &self.request {
            Request::Compress { .. } => {
                dirs.extend(self.output.parent().map(Path::to_path_buf));
                dirs.extend(
                    self.presentation
                        .as_ref()
                        .and_then(|path| path.parent())
                        .map(Path::to_path_buf),
                );
            }
            Request::Extract { archive, .. } => {
                dirs.push(self.output.clone());
                dirs.extend(self.presentation.clone());
                dirs.extend(archive.parent().map(Path::to_path_buf));
            }
        }
        let mut dirs: Vec<_> = dirs
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        dirs.sort_unstable();
        dirs.dedup();
        dirs
    }

    /// The same owned request determines execution and recovery ownership.
    ///
    /// This is a superset of the operation's **writes**. It is not a superset
    /// of its reads: capture deliberately does not follow the requested entry
    /// itself, so a selected top-level symlink to a directory is compressed by
    /// reading through it into a subtree that was never claimed. That matches
    /// the move/copy capture policy and is read-only, but it is the one place
    /// the worker touches a path outside `resources()`. Nested symlinks are
    /// skipped by the zip walk and never reached.
    ///
    /// The output is claimed as a subtree because neither operation's exact
    /// leaf set is known before it runs: compress writes one file but must
    /// exclude writers of that name, and extract writes entry names the
    /// archive chooses. A conservative superset is correct; a claim narrower
    /// than the effect would admit a competitor into the same bytes.
    #[cfg(target_os = "linux")]
    pub(crate) fn resources(&self) -> Vec<super::recovery::ResourceRequest> {
        use super::recovery::{Access, ResourceRequest, Scope};
        let mut resources = vec![ResourceRequest {
            path: self.output.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        }];
        match &self.request {
            Request::Compress { sources } => {
                resources.extend(sources.iter().map(|path| ResourceRequest {
                    path: path.clone(),
                    access: Access::Read,
                    scope: Scope::Subtree,
                }))
            }
            Request::Extract { archive, .. } => resources.push(ResourceRequest {
                path: archive.clone(),
                access: Access::Read,
                scope: Scope::Subtree,
            }),
        }
        resources
    }

    /// Bind execution to the exact ordered resources returned by admission,
    /// so a managed alias replacement cannot redirect the worker's writes.
    #[cfg(target_os = "linux")]
    pub(crate) fn resolve(
        mut self,
        paths: impl Iterator<Item = PathBuf>,
    ) -> Result<Self, AppError> {
        let mut paths = paths;
        let invalid =
            || AppError::Other("Archive admission returned inconsistent path bindings".into());
        let output = paths.next().ok_or_else(invalid)?;
        if output.file_name() != self.output.file_name() || !output.is_absolute() {
            return Err(invalid());
        }
        match &mut self.request {
            Request::Compress { sources } => {
                for source in sources.iter_mut() {
                    let bound = paths.next().ok_or_else(invalid)?;
                    if bound.file_name() != source.file_name() || !bound.is_absolute() {
                        return Err(invalid());
                    }
                    *source = bound;
                }
            }
            Request::Extract { archive, .. } => {
                let bound = paths.next().ok_or_else(invalid)?;
                if bound.file_name() != archive.file_name() || !bound.is_absolute() {
                    return Err(invalid());
                }
                *archive = bound;
            }
        }
        if paths.next().is_some() {
            return Err(invalid());
        }
        self.presentation = Some(std::mem::replace(&mut self.output, output));
        Ok(self)
    }
}

#[cfg(test)]
#[path = "../../test_support/archive_plan.rs"]
mod tests;
