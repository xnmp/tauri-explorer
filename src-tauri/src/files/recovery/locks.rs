//! Native operation ownership. Dropping a handle releases ownership, never evidence.
//! Missing/replaced locks are errors, not proof of an abandoned operation.
use super::{file_lock::FileLock, model::LockIdentity, private_storage::validate_file};
use crate::files::file_identity::of_file;
use crate::files::native_directory::Directory;
use std::{
    ffi::OsStr,
    fs::File,
    io::{self, Read, Write},
};

pub(super) struct OperationLock {
    _lock: FileLock,
    pub identity: LockIdentity,
}

pub(super) enum LockAttempt {
    Acquired(OperationLock),
    Busy,
}

impl OperationLock {
    pub(super) fn name(&self) -> &OsStr {
        OsStr::new(&self.identity.name)
    }

    /// The held OS lock must still be the exact named owner evidence.
    pub(super) fn verify(&self, directory: &Directory) -> io::Result<()> {
        validate_identity(&self.identity)?;
        let mut file = directory.open_file(self.name())?;
        validate_opened(&mut file, &self.identity)
    }

    /// Only shared admission may call this after proving no database or catalog
    /// record references the name. Busy unreferenced ownership remains unknown.
    pub(super) fn acquire_unreferenced(
        directory: &Directory,
        name: &OsStr,
    ) -> io::Result<LockAttempt> {
        let mut file = directory.open_file(name)?;
        validate_file(&file)?;
        let mut nonce = Vec::with_capacity(33);
        (&mut file).take(33).read_to_end(&mut nonce)?;
        if nonce.len() != 32 {
            return Err(invalid(
                "Unreferenced recovery lock has incomplete evidence",
            ));
        }
        let identity = LockIdentity {
            name: name
                .to_str()
                .ok_or_else(|| invalid("Recovery lock name is invalid"))?
                .to_owned(),
            object: of_file(&file)?,
            nonce: hex::encode(nonce),
        };
        validate_identity(&identity)?;
        Ok(match FileLock::try_acquire(file)? {
            Some(lock) => LockAttempt::Acquired(Self {
                _lock: lock,
                identity,
            }),
            None => LockAttempt::Busy,
        })
    }

    /// No actionable record may reference this owner. Caller holds admission.
    pub(super) fn retire(self, directory: &Directory) -> io::Result<()> {
        super::storage::retire_file(directory, self.name(), |captured| {
            let mut file = captured.open_file(self.name())?;
            validate_opened(&mut file, &self.identity)
        })
    }
    /// The caller holds shared admission while publishing this identity into
    /// durable intent. A failed publication leaves only a bounded orphan lock.
    pub(super) fn create(directory: &Directory) -> io::Result<Self> {
        let mut random = [0u8; 64];
        getrandom::fill(&mut random).map_err(io::Error::other)?;
        let name = format!("{}.lock", hex::encode(&random[..32]));
        let nonce = &random[32..];
        let mut file = directory.create_file(OsStr::new(&name))?;
        // Shared admission excludes reclamation while durable owner evidence
        // is written. No record references this file until the locked owner
        // returns; interruption here leaves only an unreferenced orphan.
        file.write_all(nonce)?;
        file.sync_all()?;
        directory.sync()?;
        validate_file(&file)?;
        let object = of_file(&file)?;
        let lock = FileLock::try_acquire(file)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::WouldBlock,
                "Recovery owner lock is already held",
            )
        })?;
        Ok(Self {
            identity: LockIdentity {
                name,
                object,
                nonce: hex::encode(nonce),
            },
            _lock: lock,
        })
    }

    pub(super) fn acquire(
        directory: &Directory,
        expected: &LockIdentity,
    ) -> io::Result<LockAttempt> {
        validate_identity(expected)?;
        let mut file = directory.open_file(OsStr::new(&expected.name))?;
        validate_opened(&mut file, expected)?;
        Ok(match FileLock::try_acquire(file)? {
            Some(lock) => LockAttempt::Acquired(Self {
                _lock: lock,
                identity: expected.clone(),
            }),
            None => LockAttempt::Busy,
        })
    }
}

fn validate_opened(file: &mut File, expected: &LockIdentity) -> io::Result<()> {
    let metadata = validate_file(file)?;
    if of_file(file)? != expected.object || metadata.len() != 32 {
        return Err(invalid("Recovery owner lock identity changed"));
    }
    let mut nonce = Vec::with_capacity(33);
    file.take(33).read_to_end(&mut nonce)?;
    if nonce.len() != 32 || hex::encode(&nonce) != expected.nonce {
        return Err(invalid("Recovery owner lock nonce changed"));
    }
    Ok(())
}

pub(super) fn validate_identity(identity: &LockIdentity) -> io::Result<()> {
    identity.validate()
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(all(test, unix))]
#[path = "../../../test_support/recovery_locks.rs"]
mod tests;
