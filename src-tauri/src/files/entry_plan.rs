//! Owned entry requests. Path derivation is pure and shared by history admission,
//! execution and refresh; the filesystem is inspected only by the worker.
use crate::error::AppError;
use std::path::{Path, PathBuf};

pub(crate) struct EntryPlan {
    target: PathBuf,
    request: Request,
    presentation: Option<PathBuf>,
}

pub(super) enum Request {
    CreateDirectory,
    CreateEmptyFile,
    Rename {
        source: PathBuf,
        old_name: String,
        new_name: String,
    },
    WriteText {
        content: String,
    },
    Symlink {
        target: PathBuf,
        probe_target: Option<PathBuf>,
    },
}

impl EntryPlan {
    pub(crate) fn create_directory(parent: String, name: String) -> Result<Self, AppError> {
        Self::create(parent, name, Request::CreateDirectory)
    }

    pub(crate) fn create_empty_file(parent: String, name: String) -> Result<Self, AppError> {
        Self::create(parent, name, Request::CreateEmptyFile)
    }

    fn create(parent: String, name: String, request: Request) -> Result<Self, AppError> {
        validate_entry_name(&name)?;
        Ok(Self {
            presentation: None,
            target: Path::new(&parent).join(name),
            request,
        })
    }

    pub(crate) fn rename(path: String, new_name: String) -> Result<Self, AppError> {
        validate_entry_name(&new_name)?;
        let source = PathBuf::from(path);
        let parent = source.parent().ok_or_else(|| {
            AppError::InvalidPath(format!(
                "Cannot get parent directory of: {}",
                source.display()
            ))
        })?;
        let old_name = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(Self {
            presentation: None,
            target: parent.join(&new_name),
            request: Request::Rename {
                source,
                old_name,
                new_name,
            },
        })
    }

    pub(crate) fn write_text(path: String, content: String) -> Self {
        Self {
            presentation: None,
            target: PathBuf::from(path),
            request: Request::WriteText { content },
        }
    }

    pub(crate) fn symlink(target: String, link: String) -> Self {
        Self {
            presentation: None,
            target: PathBuf::from(link),
            request: Request::Symlink {
                target: PathBuf::from(target),
                probe_target: None,
            },
        }
    }

    pub(crate) fn affected_dirs(&self) -> Vec<String> {
        let mut parents: Vec<_> = self
            .target
            .parent()
            .into_iter()
            .chain(self.presentation.as_ref().and_then(|path| path.parent()))
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        parents.sort_unstable();
        parents.dedup();
        parents
    }

    /// The history layer decides whether this successful request has an inverse.
    /// Names come from the exact planned rename, never a separate caller closure.
    pub(crate) fn rename_names(&self) -> Option<(&str, &str)> {
        match &self.request {
            Request::Rename {
                old_name, new_name, ..
            } => Some((old_name, new_name)),
            _ => None,
        }
    }

    /// The same owned request determines execution and recovery ownership.
    #[cfg(target_os = "linux")]
    pub(crate) fn resources(&self) -> Vec<super::recovery::ResourceRequest> {
        use super::recovery::{Access, ResourceRequest, Scope};
        let mut resources = vec![ResourceRequest {
            path: self.target.clone(),
            access: Access::Write,
            scope: Scope::Subtree,
        }];
        match &self.request {
            Request::Rename { source, .. } => resources.push(ResourceRequest {
                path: source.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            }),
            Request::Symlink { target, .. } => resources.push(ResourceRequest {
                path: target.clone(),
                access: Access::Read,
                scope: Scope::Entry,
            }),
            _ => {}
        }
        resources
    }

    pub(crate) fn target(&self) -> &Path {
        &self.target
    }

    /// Bind execution to the exact ordered resources returned by admission.
    /// Keep link text literal; its existence probe uses the captured target.
    #[cfg(target_os = "linux")]
    pub(crate) fn resolve(
        mut self,
        paths: impl Iterator<Item = PathBuf>,
    ) -> Result<Self, AppError> {
        let mut paths = paths;
        let missing =
            || AppError::Other("Entry admission returned incomplete path bindings".into());
        let target = paths.next().ok_or_else(missing)?;
        match &mut self.request {
            Request::Rename { source, .. } => *source = paths.next().ok_or_else(missing)?,
            Request::Symlink { probe_target, .. } => {
                *probe_target = Some(paths.next().ok_or_else(missing)?)
            }
            _ => {}
        }
        if paths.next().is_some() {
            return Err(AppError::Other(
                "Entry admission returned excess path bindings".into(),
            ));
        }
        self.presentation = Some(std::mem::replace(&mut self.target, target));
        Ok(self)
    }

    pub(super) fn into_parts(self) -> (PathBuf, Request, Option<PathBuf>) {
        (self.target, self.request, self.presentation)
    }
}

pub(super) fn validate_entry_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() {
        return Err(AppError::InvalidPath("Name cannot be empty".into()));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(AppError::InvalidPath(format!(
            "Name cannot contain path separators: {name}"
        )));
    }
    if matches!(name, "." | "..") {
        return Err(AppError::InvalidPath(format!("Invalid name: {name}")));
    }
    Ok(())
}
