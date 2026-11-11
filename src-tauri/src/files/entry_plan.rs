//! Owned entry requests. Path derivation is pure and shared by history admission,
//! execution and refresh; the filesystem is inspected only by the worker.
//!
//! Every path and name arrives in wire form and is decoded here, before the
//! structural checks run on the native value (#1592, ADR 0031).
use crate::error::AppError;
use crate::wire_path;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

pub(crate) struct EntryPlan {
    target: PathBuf,
    request: Request,
    presentation: Option<PathBuf>,
}

pub(super) enum Request {
    CreateDirectory,
    CreateEmptyFile,
    /// `old_name` and `new_name` are canonical wire names for history.
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
        let parent = wire_path::decode(&parent)?;
        let name = wire_path::decode_name(&name)?;
        validate_entry_name(&name)?;
        Ok(Self {
            presentation: None,
            target: parent.join(name),
            request,
        })
    }

    pub(crate) fn rename(path: String, new_name: String) -> Result<Self, AppError> {
        let source = wire_path::decode(&path)?.into_owned();
        let native_name = wire_path::decode_name(&new_name)?;
        validate_entry_name(&native_name)?;
        let parent = source.parent().ok_or_else(|| {
            AppError::InvalidPath(format!(
                "Cannot get parent directory of: {}",
                source.display()
            ))
        })?;
        let old_name = source
            .file_name()
            .map(|name| wire_path::encode(name).into_owned())
            .unwrap_or_default();
        Ok(Self {
            presentation: None,
            target: parent.join(&native_name),
            request: Request::Rename {
                source,
                old_name,
                new_name,
            },
        })
    }

    pub(crate) fn write_text(path: String, content: String) -> Result<Self, AppError> {
        Ok(Self {
            presentation: None,
            target: wire_path::decode(&path)?.into_owned(),
            request: Request::WriteText { content },
        })
    }

    pub(crate) fn symlink(target: String, link: String) -> Result<Self, AppError> {
        Ok(Self {
            presentation: None,
            target: wire_path::decode(&link)?.into_owned(),
            request: Request::Symlink {
                target: wire_path::decode(&target)?.into_owned(),
                probe_target: None,
            },
        })
    }

    pub(crate) fn affected_dirs(&self) -> Vec<String> {
        let mut parents: Vec<_> = self
            .target
            .parent()
            .into_iter()
            .chain(self.presentation.as_ref().and_then(|path| path.parent()))
            .map(|path| wire_path::encode_path(path).into_owned())
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

    pub(crate) fn target(&self) -> &Path {
        &self.target
    }

    pub(super) fn into_parts(self) -> (PathBuf, Request, Option<PathBuf>) {
        (self.target, self.request, self.presentation)
    }
}

impl super::admission::Plan for EntryPlan {
    /// The same owned request determines execution and recovery ownership.
    #[cfg(target_os = "linux")]
    fn resources(&self) -> Vec<super::recovery::ResourceRequest> {
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

    /// Bind execution to the exact ordered resources returned by admission.
    /// Keep link text literal; its existence probe uses the captured target.
    #[cfg(target_os = "linux")]
    fn resolve(mut self, paths: impl Iterator<Item = PathBuf>) -> Result<Self, AppError> {
        let mut paths = paths;
        let missing =
            || AppError::Other("Entry admission returned incomplete path bindings".into());
        let target = paths.next().ok_or_else(missing)?;
        match &mut self.request {
            Request::Rename { source, .. } => {
                let resolved_source = paths.next().ok_or_else(missing)?;
                // Admission observes paths independently. A parent alias can
                // change between captures; rename must never become a move
                // from a different directory or change either requested leaf.
                if resolved_source.parent() != target.parent()
                    || resolved_source.file_name() != source.file_name()
                    || target.file_name() != self.target.file_name()
                {
                    return Err(AppError::InvalidPath(
                        "Rename path bindings changed during admission".into(),
                    ));
                }
                *source = resolved_source;
            }
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
}

/// Structural checks on the decoded native name. Separators and dots are
/// ASCII, so they are checked on bytes whatever the name's encoding.
pub(super) fn validate_entry_name(name: impl AsRef<OsStr>) -> Result<(), AppError> {
    let name = name.as_ref();
    let bytes = name.as_encoded_bytes();
    let display = || wire_path::lossy(&wire_path::encode(name)).into_owned();
    if bytes.is_empty() {
        return Err(AppError::InvalidPath("Name cannot be empty".into()));
    }
    if bytes.iter().any(|byte| matches!(byte, b'/' | b'\\')) {
        return Err(AppError::InvalidPath(format!(
            "Name cannot contain path separators: {}",
            display()
        )));
    }
    if matches!(bytes, b"." | b"..") {
        return Err(AppError::InvalidPath(format!(
            "Invalid name: {}",
            display()
        )));
    }
    Ok(())
}
