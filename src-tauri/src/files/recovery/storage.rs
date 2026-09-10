//! Bounded immutable discovery evidence, independent of the SQLite index.
//! Callers serialize publication/retirement with shared admission. The catalog
//! never probes the user paths encoded in its opaque payloads.
use super::{
    journal::{MAX_RECORDS, MAX_RECORD_BYTES, MAX_TOTAL_BYTES},
    model::ObjectId,
    private_storage::{validate_directory, validate_file},
};
use crate::{
    error::AppError,
    files::{file_identity::of_file, native_directory::Directory},
};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::File,
    io::{self, Read, Write},
};

const MAGIC: &[u8; 8] = b"TERCV001";
const HEADER_BYTES: usize = MAGIC.len() + 32;

pub(super) struct Catalog {
    directory: Directory,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) struct Evidence {
    pub id: String,
    pub payload: Vec<u8>,
    object: ObjectId,
    digest: [u8; 32],
}

impl Evidence {
    /// Reuse the checksum already verified by the framed catalog read.
    pub(super) fn digest(&self) -> [u8; 32] {
        self.digest
    }
}

impl Catalog {
    pub(super) fn identity(&self) -> io::Result<ObjectId> {
        of_file(&self.directory.file)
    }
    pub(super) fn open(directory: Directory) -> io::Result<Self> {
        validate_directory(&directory)?;
        Ok(Self { directory })
    }

    pub(super) fn records(&self) -> io::Result<Vec<Evidence>> {
        let mut names = self.directory.names(MAX_RECORDS)?;
        names.sort();
        let mut total = 0usize;
        let mut records = Vec::with_capacity(names.len());
        for name in names {
            let id = name
                .to_str()
                .and_then(|name| name.strip_suffix(".intent"))
                .filter(|id| valid_id(id))
                .ok_or_else(|| invalid("Unknown recovery catalog entry"))?;
            // Check each allocation against the remaining aggregate budget too.
            let record = self.read(id, MAX_TOTAL_BYTES - total)?;
            total += record.payload.len();
            records.push(record);
        }
        Ok(records)
    }

    /// Return the already-published evidence when it is byte-for-byte equal,
    /// or publish it when absent. Existing evidence is never replaced: a
    /// malformed or different record is retained for recovery inspection.
    pub(super) fn ensure_exact(&self, id: &str, payload: &[u8]) -> Result<Evidence, AppError> {
        self.ensure_exact_with(id, payload, File::sync_all, Directory::sync)
    }

    fn ensure_exact_with(
        &self,
        id: &str,
        payload: &[u8],
        sync_file: impl FnOnce(&File) -> io::Result<()>,
        sync_directory: impl FnOnce(&Directory) -> io::Result<()>,
    ) -> Result<Evidence, AppError> {
        validate_entry(id, payload)?;
        match self.read_file(id, MAX_RECORD_BYTES) {
            Ok((existing, file)) => {
                self.accept_existing(existing, file, payload, sync_file, sync_directory)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match self.publish(id, payload) {
                    Ok(published) => {
                        if self.read(id, MAX_RECORD_BYTES)? != published {
                            return Err(invalid(
                                "Recovery catalog evidence changed after publication",
                            )
                            .into());
                        }
                        Ok(published)
                    }
                    // Publication is exclusive. If another admitted caller
                    // won the absent/read race, accept only its exact record.
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        let (existing, file) = self.read_file(id, MAX_RECORD_BYTES)?;
                        self.accept_existing(existing, file, payload, sync_file, sync_directory)
                    }
                    Err(error) => Err(error.into()),
                }
            }
            Err(error) => Err(error.into()),
        }
    }

    fn accept_existing(
        &self,
        existing: Evidence,
        file: File,
        payload: &[u8],
        sync_file: impl FnOnce(&File) -> io::Result<()>,
        sync_directory: impl FnOnce(&Directory) -> io::Result<()>,
    ) -> Result<Evidence, AppError> {
        let existing = exact_evidence(existing, payload)?;
        sync_file(&file)?;
        sync_directory(&self.directory)?;
        if self.read(&existing.id, MAX_RECORD_BYTES)? != existing {
            return Err(invalid(
                "Recovery catalog evidence changed across its durability barriers",
            )
            .into());
        }
        Ok(existing)
    }

    /// Catalog intent must finish before artifact creation or user-byte moves.
    /// Failed/partial writes remain visible as uncertain evidence, never evicted.
    pub(super) fn publish(&self, id: &str, payload: &[u8]) -> io::Result<Evidence> {
        validate_entry(id, payload)?;
        let records = self.records()?;
        if records.len() >= MAX_RECORDS
            || records
                .iter()
                .map(|record| record.payload.len())
                .sum::<usize>()
                + payload.len()
                > MAX_TOTAL_BYTES
        {
            return Err(invalid("Recovery catalog is full"));
        }
        let name = format!("{id}.intent");
        let mut file = self.directory.create_file(OsStr::new(&name))?;
        let digest: [u8; 32] = Sha256::digest(payload).into();
        file.write_all(MAGIC)?;
        file.write_all(&digest)?;
        file.write_all(payload)?;
        file.sync_all()?;
        self.directory.sync()?;
        validate_file(&file)?;
        Ok(Evidence {
            id: id.to_owned(),
            payload: payload.to_vec(),
            object: of_file(&file)?,
            digest,
        })
    }

    /// Read a named immutable manifest without creating or repairing evidence.
    pub(super) fn read_exact(&self, id: &str, payload: &[u8]) -> Result<Evidence, AppError> {
        validate_entry(id, payload)?;
        exact_evidence(self.read(id, MAX_RECORD_BYTES)?, payload).map_err(AppError::from)
    }

    pub(super) fn verify(&self, expected: &Evidence) -> io::Result<()> {
        if self.read(&expected.id, MAX_RECORD_BYTES)? != *expected {
            return Err(invalid("Recovery catalog evidence changed"));
        }
        Ok(())
    }

    /// Caller must first durably finish artifact cleanup and hold admission.
    /// Exact evidence is required; an ID alone never authorizes retirement.
    pub(super) fn retire(&self, expected: &Evidence) -> io::Result<()> {
        self.retire_with(expected, || {})
    }

    fn retire_with(&self, expected: &Evidence, before_capture: impl FnOnce()) -> io::Result<()> {
        if self.read(&expected.id, MAX_RECORD_BYTES)? != *expected {
            return Err(invalid(
                "Recovery catalog evidence changed before retirement",
            ));
        }
        before_capture();
        let name = format!("{}.intent", expected.id);
        retire_file(&self.directory, OsStr::new(&name), |captured| {
            if Self::read_in(captured, &expected.id, OsStr::new(&name), MAX_RECORD_BYTES)?
                != *expected
            {
                return Err(invalid(
                    "Recovery retirement captured different evidence; private quarantine retained",
                ));
            }
            Ok(())
        })
    }

    fn read(&self, id: &str, remaining: usize) -> io::Result<Evidence> {
        self.read_file(id, remaining)
            .map(|(evidence, _file)| evidence)
    }

    fn read_file(&self, id: &str, remaining: usize) -> io::Result<(Evidence, File)> {
        if !valid_id(id) {
            return Err(invalid("Recovery catalog ID is invalid"));
        }
        let name = format!("{id}.intent");
        Self::read_file_in(&self.directory, id, OsStr::new(&name), remaining)
    }

    fn read_in(
        directory: &Directory,
        id: &str,
        name: &OsStr,
        remaining: usize,
    ) -> io::Result<Evidence> {
        Self::read_file_in(directory, id, name, remaining).map(|(evidence, _file)| evidence)
    }

    fn read_file_in(
        directory: &Directory,
        id: &str,
        name: &OsStr,
        remaining: usize,
    ) -> io::Result<(Evidence, File)> {
        let file = directory.open_file(name)?;
        let metadata = validate_file(&file)?;
        let maximum = MAX_RECORD_BYTES.min(remaining) + HEADER_BYTES;
        let length = usize::try_from(metadata.len())
            .map_err(|_| invalid("Recovery intent length overflowed"))?;
        if !(HEADER_BYTES..=maximum).contains(&length) {
            return Err(invalid(
                "Recovery intent is truncated or exceeds its storage limit",
            ));
        }
        let object = of_file(&file)?;
        let mut bytes = Vec::with_capacity(length);
        (&file).take(maximum as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() != length || &bytes[..MAGIC.len()] != MAGIC {
            return Err(invalid("Recovery intent changed or has an unknown format"));
        }
        let payload = &bytes[HEADER_BYTES..];
        let digest: [u8; 32] = Sha256::digest(payload).into();
        if digest.as_slice() != &bytes[MAGIC.len()..HEADER_BYTES] {
            return Err(invalid("Recovery intent checksum does not match"));
        }
        Ok((
            Evidence {
                id: id.to_owned(),
                payload: payload.to_vec(),
                object,
                digest,
            },
            file,
        ))
    }
}

fn exact_evidence(existing: Evidence, payload: &[u8]) -> io::Result<Evidence> {
    if existing.payload == payload {
        Ok(existing)
    } else {
        Err(invalid(
            "Recovery catalog ID already contains different evidence",
        ))
    }
}

fn validate_entry(id: &str, payload: &[u8]) -> io::Result<()> {
    if !valid_id(id) || payload.len() > MAX_RECORD_BYTES {
        Err(invalid("Recovery intent exceeds its ID or payload limit"))
    } else {
        Ok(())
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Capture a private entry before validating it for deletion. Any failure keeps
/// the quarantine visible to the owner's bounded enumeration/reconciliation.
pub(super) fn retire_file(
    directory: &Directory,
    name: &OsStr,
    validate: impl FnOnce(&Directory) -> io::Result<()>,
) -> io::Result<()> {
    let mut nonce = [0; 32];
    getrandom::fill(&mut nonce).map_err(io::Error::other)?;
    let quarantine_name = format!(".retiring-{}", hex::encode(nonce));
    let quarantine = directory.create_directory(OsStr::new(&quarantine_name))?;
    directory.rename_to(name, &quarantine, name)?;
    quarantine.sync()?;
    directory.sync()?;
    validate(&quarantine)?;
    quarantine.unlink(name, false)?;
    quarantine.sync()?;
    directory.unlink(OsStr::new(&quarantine_name), true)?;
    directory.sync()
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(all(test, unix))]
#[path = "../../../test_support/recovery_storage.rs"]
mod tests;
