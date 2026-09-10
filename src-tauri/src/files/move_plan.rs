//! One immutable move intent supplies both recovery claims and worker paths.
use crate::error::AppError;
use std::path::{Component, Path, PathBuf};

pub(crate) struct MovePlan {
    pub(super) source: PathBuf,
    pub(super) target: PathBuf,
    pub(super) overwrite: bool,
    pub(super) presentation: Option<PathBuf>,
    original_source: Option<PathBuf>,
}

impl MovePlan {
    pub(crate) fn new(
        source: String,
        destination: String,
        overwrite: bool,
    ) -> Result<Self, AppError> {
        for path in [&source, &destination] {
            let native = Path::new(path);
            if path.len() > 128 * 1024
                || path.contains('\0')
                || !native.is_absolute()
                || native
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
            {
                return Err(AppError::InvalidPath(
                    "Move requires bounded absolute paths without parent traversal or NUL bytes"
                        .into(),
                ));
            }
        }
        let source = PathBuf::from(source);
        let name = source
            .file_name()
            .ok_or_else(|| AppError::InvalidPath("Move source requires an entry name".into()))?;
        let target = Path::new(&destination).join(name);
        Ok(Self {
            source,
            target,
            overwrite,
            presentation: None,
            original_source: None,
        })
    }

    pub(crate) fn affected_dirs(&self) -> Vec<String> {
        let mut dirs: Vec<_> = [&self.source, &self.target]
            .into_iter()
            .chain(self.presentation.as_ref())
            .chain(self.original_source.as_ref())
            .filter_map(|path| path.parent())
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        dirs.sort_unstable();
        dirs.dedup();
        dirs
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn resources(&self) -> Vec<super::recovery::ResourceRequest> {
        use super::recovery::{Access, ResourceRequest, Scope};
        [&self.source, &self.target]
            .into_iter()
            .map(|path| ResourceRequest {
                path: path.clone(),
                access: Access::Write,
                scope: Scope::Subtree,
            })
            .collect()
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn resolve(
        mut self,
        paths: impl Iterator<Item = PathBuf>,
    ) -> Result<Self, AppError> {
        let mut paths = paths;
        let invalid =
            || AppError::Other("Move admission returned inconsistent path bindings".into());
        let source = paths.next().ok_or_else(invalid)?;
        let target = paths.next().ok_or_else(invalid)?;
        // Capture resolves parent aliases only. Following a source leaf here
        // would move a symlink's referent instead of the selected symlink.
        if paths.next().is_some()
            || source.file_name() != self.source.file_name()
            || target.file_name() != self.target.file_name()
            || !source.is_absolute()
            || !target.is_absolute()
        {
            return Err(invalid());
        }
        self.original_source = Some(std::mem::replace(&mut self.source, source));
        self.presentation = Some(std::mem::replace(&mut self.target, target));
        Ok(self)
    }
}
