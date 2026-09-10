//! Descriptor-relative, cancellable copying into an already-owned private root.
//! Errors deliberately retain partial output for the recovery phase owner.

use super::{
    entry_version::EntryVersion,
    file_identity::{version_at, version_from_metadata},
    native_directory::Directory,
};
use crate::{error::AppError, progress::ProgressTracker};
use std::{
    ffi::OsStr,
    fs,
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    path::Path,
};

const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const MAX_DEPTH: usize = 256;
const MAX_SYMLINK_BYTES: usize = 64 * 1024;

pub(crate) trait CopyProgress {
    fn check_cancelled(&mut self) -> Result<(), AppError>;
    fn advance(&mut self, bytes: u64, current_file: &Path) -> Result<(), AppError>;
}

impl CopyProgress for ProgressTracker<'_> {
    fn check_cancelled(&mut self) -> Result<(), AppError> {
        ProgressTracker::check_cancelled(self)
    }

    fn advance(&mut self, bytes: u64, current_file: &Path) -> Result<(), AppError> {
        ProgressTracker::advance(self, bytes, current_file)
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct CopyOutcome {
    pub version: EntryVersion,
    pub final_mode: Option<u32>,
}

/// Copy one exact source entry into an absent target name. Source and target
/// payloads are never reopened by path; `display_path` is progress text only.
/// Each completed directory syncs all child names once, and this outer boundary
/// syncs the root name before returning the final observed version.
pub(super) fn copy_entry(
    source_parent: &Directory,
    source_name: &OsStr,
    target_parent: &Directory,
    target_name: &OsStr,
    display_path: &Path,
    expected: &EntryVersion,
    progress: &mut impl CopyProgress,
) -> Result<CopyOutcome, AppError> {
    copy_with(
        Source {
            parent: source_parent,
            name: source_name,
            display_path,
            expected,
        },
        Target {
            parent: target_parent,
            name: target_name,
        },
        progress,
        true,
    )
}

/// Ordinary staged copies retain the same identity checks and shared buffer,
/// without the per-file durability barriers required by a recovery journal.
pub(super) fn copy_entry_buffered(
    source_parent: &Directory,
    source_name: &OsStr,
    target_parent: &Directory,
    target_name: &OsStr,
    display_path: &Path,
    expected: &EntryVersion,
    progress: &mut impl CopyProgress,
) -> Result<CopyOutcome, AppError> {
    copy_with(
        Source {
            parent: source_parent,
            name: source_name,
            display_path,
            expected,
        },
        Target {
            parent: target_parent,
            name: target_name,
        },
        progress,
        false,
    )
}

fn copy_with(
    source: Source<'_>,
    target: Target<'_>,
    progress: &mut impl CopyProgress,
    durable: bool,
) -> Result<CopyOutcome, AppError> {
    let Source {
        parent: source_parent,
        name: source_name,
        expected,
        ..
    } = source;
    let Target {
        parent: target_parent,
        name: target_name,
    } = target;
    expected.validate()?;
    verify_named(source_parent, source_name, expected)?;
    let mut copier = Copier {
        progress,
        buffer: vec![0; COPY_BUFFER_BYTES],
        durable,
    };
    let version = copier.copy_node(source, target, 1, true)?;
    copier.progress.check_cancelled()?;
    if durable {
        target_parent.sync()?;
    }
    verify_target(target_parent, target_name, &version)?;
    verify_named(source_parent, source_name, expected)?;
    Ok(CopyOutcome {
        version,
        final_mode: expected.directory.then_some(permission_mode(expected)),
    })
}

#[derive(Clone, Copy)]
struct Source<'a> {
    parent: &'a Directory,
    name: &'a OsStr,
    display_path: &'a Path,
    expected: &'a EntryVersion,
}

#[derive(Clone, Copy)]
struct Target<'a> {
    parent: &'a Directory,
    name: &'a OsStr,
}

struct Copier<'a, P> {
    progress: &'a mut P,
    buffer: Vec<u8>,
    durable: bool,
}

impl<P: CopyProgress> Copier<'_, P> {
    fn copy_node(
        &mut self,
        source: Source<'_>,
        target: Target<'_>,
        depth: usize,
        root: bool,
    ) -> Result<EntryVersion, AppError> {
        if depth > MAX_DEPTH {
            return Err(AppError::InvalidPath(format!(
                "Copy source exceeds the {MAX_DEPTH}-directory depth limit"
            )));
        }
        verify_named(source.parent, source.name, source.expected)?;
        if source.expected.symlink {
            self.copy_symlink(source, target)
        } else if source.expected.directory {
            self.copy_directory(source, target, depth, root)
        } else if source.expected.mode & 0o170000 == 0o100000 {
            self.copy_file(source, target)
        } else {
            Err(AppError::InvalidPath(format!(
                "Copy source is not a regular file, directory, or symbolic link: {}",
                source.display_path.display()
            )))
        }
    }

    fn copy_file(
        &mut self,
        source_entry: Source<'_>,
        target_entry: Target<'_>,
    ) -> Result<EntryVersion, AppError> {
        let mut source = source_entry.parent.open_file(source_entry.name)?;
        verify_handle(
            &source,
            source_entry.expected,
            "Copy source file changed before reading",
        )?;
        self.progress.check_cancelled()?;
        let mut target = target_entry.parent.create_file(target_entry.name)?;
        let mut remaining = source_entry.expected.size;
        while remaining != 0 {
            self.progress.check_cancelled()?;
            let requested = usize::try_from(remaining.min(self.buffer.len() as u64))
                .expect("copy chunk is bounded by the buffer length");
            let read = source.read(&mut self.buffer[..requested])?;
            if read == 0 {
                return Err(AppError::Other(
                    "Copy source file became shorter while reading".into(),
                ));
            }
            self.progress.check_cancelled()?;
            target.write_all(&self.buffer[..read])?;
            self.progress
                .advance(read as u64, source_entry.display_path)?;
            remaining -= read as u64;
        }
        self.progress.check_cancelled()?;
        if source.read(&mut self.buffer[..1])? != 0 {
            return Err(AppError::Other(
                "Copy source file became longer while reading".into(),
            ));
        }
        self.progress.check_cancelled()?;
        target.flush()?;
        verify_handle(
            &source,
            source_entry.expected,
            "Copy source file changed while reading",
        )?;
        verify_named(
            source_entry.parent,
            source_entry.name,
            source_entry.expected,
        )?;
        self.progress.check_cancelled()?;
        target.set_permissions(fs::Permissions::from_mode(permission_mode(
            source_entry.expected,
        )))?;
        self.progress.check_cancelled()?;
        if self.durable {
            target.sync_all()?;
        }
        self.progress.check_cancelled()?;
        let version = version_from_metadata(&target.metadata()?)?;
        verify_target(target_entry.parent, target_entry.name, &version)?;
        verify_handle(
            &source,
            source_entry.expected,
            "Copy source file changed before completion",
        )?;
        verify_named(
            source_entry.parent,
            source_entry.name,
            source_entry.expected,
        )?;
        Ok(version)
    }

    fn copy_directory(
        &mut self,
        source_entry: Source<'_>,
        target_entry: Target<'_>,
        depth: usize,
        root: bool,
    ) -> Result<EntryVersion, AppError> {
        let source = source_entry.parent.open_existing(source_entry.name)?;
        verify_directory_handle(
            &source,
            source_entry.expected,
            "Copy source directory changed before reading",
        )?;
        self.progress.check_cancelled()?;
        let target = target_entry.parent.create_directory(target_entry.name)?;
        for name in source.entries()? {
            let name = name?;
            self.progress.check_cancelled()?;
            let child = version_at(&source, &name)?;
            let child_display = source_entry.display_path.join(&name);
            self.copy_node(
                Source {
                    parent: &source,
                    name: &name,
                    display_path: &child_display,
                    expected: &child,
                },
                Target {
                    parent: &target,
                    name: &name,
                },
                depth + 1,
                false,
            )?;
        }
        verify_directory_handle(
            &source,
            source_entry.expected,
            "Copy source directory changed while reading",
        )?;
        verify_named(
            source_entry.parent,
            source_entry.name,
            source_entry.expected,
        )?;
        self.progress.check_cancelled()?;
        let final_mode = permission_mode(source_entry.expected);
        let applied_mode = if root { final_mode | 0o700 } else { final_mode };
        target
            .file
            .set_permissions(fs::Permissions::from_mode(applied_mode))?;
        self.progress.check_cancelled()?;
        if self.durable {
            target.sync()?;
        }
        self.progress.check_cancelled()?;
        let version = version_from_metadata(&target.metadata()?)?;
        verify_target(target_entry.parent, target_entry.name, &version)?;
        verify_directory_handle(
            &source,
            source_entry.expected,
            "Copy source directory changed before completion",
        )?;
        verify_named(
            source_entry.parent,
            source_entry.name,
            source_entry.expected,
        )?;
        Ok(version)
    }

    fn copy_symlink(
        &mut self,
        source: Source<'_>,
        target: Target<'_>,
    ) -> Result<EntryVersion, AppError> {
        let link = source.parent.read_link(source.name, MAX_SYMLINK_BYTES)?;
        verify_named(source.parent, source.name, source.expected)?;
        self.progress.check_cancelled()?;
        target.parent.create_symlink(target.name, &link)?;
        let version = version_at(target.parent, target.name)?;
        let created_link = target.parent.read_link(target.name, MAX_SYMLINK_BYTES)?;
        if !version.symlink || created_link != link {
            return Err(AppError::MutationUncertain(
                "Copy target symbolic link changed during creation".into(),
            ));
        }
        self.progress
            .advance(source.expected.size, source.display_path)?;
        verify_named(source.parent, source.name, source.expected)?;
        verify_target(target.parent, target.name, &version)?;
        if target.parent.read_link(target.name, MAX_SYMLINK_BYTES)? != link {
            return Err(AppError::MutationUncertain(
                "Copy target symbolic link changed before durability completed".into(),
            ));
        }
        Ok(version)
    }
}

fn verify_handle(file: &fs::File, expected: &EntryVersion, message: &str) -> Result<(), AppError> {
    if version_from_metadata(&file.metadata()?)? != *expected {
        return Err(AppError::Other(message.into()));
    }
    Ok(())
}

fn verify_directory_handle(
    directory: &Directory,
    expected: &EntryVersion,
    message: &str,
) -> Result<(), AppError> {
    if version_from_metadata(&directory.metadata()?)? != *expected {
        return Err(AppError::Other(message.into()));
    }
    Ok(())
}

fn verify_named(parent: &Directory, name: &OsStr, expected: &EntryVersion) -> Result<(), AppError> {
    if version_at(parent, name)? != *expected {
        return Err(AppError::Other(
            "Copy source name or contents changed after admission".into(),
        ));
    }
    Ok(())
}

fn verify_target(
    parent: &Directory,
    name: &OsStr,
    expected: &EntryVersion,
) -> Result<(), AppError> {
    if version_at(parent, name)? != *expected {
        return Err(AppError::MutationUncertain(
            "Copy target namespace changed before durability completed".into(),
        ));
    }
    Ok(())
}

fn permission_mode(version: &EntryVersion) -> u32 {
    version.mode & 0o7777
}

#[cfg(test)]
#[path = "../../test_support/anchored_copy.rs"]
mod tests;
