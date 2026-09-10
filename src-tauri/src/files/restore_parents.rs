//! Recreate restore parents while retaining every possible directory effect.
use super::batch::DirectoryEffects;
use crate::error::AppError;
use std::{fs, io, path::Path};

pub(super) fn create(directory: &Path, effects: &DirectoryEffects) -> Result<(), AppError> {
    create_with(directory, effects, |path| fs::create_dir(path))
}

fn create_with(
    directory: &Path,
    effects: &DirectoryEffects,
    mut mkdir: impl FnMut(&Path) -> io::Result<()>,
) -> Result<(), AppError> {
    // Borrow prefixes instead of cloning each ancestor, and avoid recursive
    // stack growth. Metadata follows directory symlinks like create_dir_all.
    let mut missing = Vec::new();
    for ancestor in directory.ancestors() {
        match fs::metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() => break,
            Ok(_) => return Err(io::Error::from(io::ErrorKind::NotADirectory).into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => missing.push(ancestor),
            Err(error) => return Err(error.into()),
        }
    }
    for path in missing.into_iter().rev() {
        effects.before_create(path)?;
        if let Err(error) = mkdir(path) {
            // Concurrent creators are successful, but files and broken links
            // must remain obstructions. Never overwrite or remove them.
            if !fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
                return Err(error.into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../test_support/restore_parents.rs"]
mod tests;
