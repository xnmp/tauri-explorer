//! Scoped OS ownership over an independently opened recovery file.
//! Dropping this guard releases the lock, never its on-disk evidence.
use std::{fs::File, io};

#[cfg(windows)]
#[path = "file_lock/windows.rs"]
mod windows;

pub(super) struct FileLock {
    file: File,
}

impl FileLock {
    /// Callers supply a fresh open description, not a clone of another lock
    /// handle. Validation of the captured file's identity remains their policy.
    pub(super) fn acquire(file: File) -> io::Result<Self> {
        if !lock(&file, true)? {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Recovery lock was not acquired",
            ));
        }
        Ok(Self { file })
    }

    pub(super) fn try_acquire(file: File) -> io::Result<Option<Self>> {
        if lock(&file, false)? {
            Ok(Some(Self { file }))
        } else {
            Ok(None)
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        if let Err(error) = unlock(&self.file) {
            log::error!("Could not release recovery file ownership: {error}");
        }
    }
}

#[cfg(unix)]
fn lock(file: &File, wait: bool) -> io::Result<bool> {
    if wait {
        file.lock()?;
        return Ok(true);
    }
    match file.try_lock() {
        Ok(()) => Ok(true),
        Err(std::fs::TryLockError::WouldBlock) => Ok(false),
        Err(std::fs::TryLockError::Error(error)) => Err(error),
    }
}

#[cfg(unix)]
fn unlock(file: &File) -> io::Result<()> {
    file.unlock()
}

#[cfg(windows)]
use windows::{lock, unlock};

#[cfg(test)]
#[path = "../../../test_support/recovery_file_lock.rs"]
mod tests;
