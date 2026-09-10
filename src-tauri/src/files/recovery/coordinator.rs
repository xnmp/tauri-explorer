//! Lazy blocking recovery owner. The process mutex protects this connection;
//! the persistent OS admission lock arbitrates with other native processes.
//! No user-file effects run while either admission lock is held.
use super::{
    file_lock::FileLock,
    journal::{Journal, RecordKind, MAX_RECORDS},
    locks::{LockAttempt, OperationLock},
    model::{DurableIntent, LockIdentity, ObjectId, OperationCheckpoint, OperationRecord},
    private_storage::{validate_directory as validate_private_directory, validate_file},
    resources::{self, ConflictIndex, Request, Resource},
    storage::{Catalog, Evidence},
};
use crate::files::file_identity::of_file;
use crate::{error::AppError, files::native_directory::Directory};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs::{self, File},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

mod admission;
mod claim;
mod claims;
mod inventory;
mod promotion;

pub(super) use inventory::InventoryEntry;

#[cfg(test)]
#[path = "../../../test_support/recovery_operation_fixture.rs"]
pub(super) mod test_fixture;

/// Stable content positions accepted by native replacement history.
#[derive(Clone, Copy)]
pub(super) enum HistoryPosition {
    Published,
    Restored,
}

/// Unlike an ordinary reservation this owner has no `finish` capability. Only
/// verified reconciliation may retire the durable record and catalog evidence.
/// Drop closes the native lock while preserving all discoverable authority.
pub(crate) struct DurableOperation {
    owner: OperationLock,
    coordinator: Arc<Coordinator>,
    generation: u64,
    record: OperationRecord,
    evidence: Evidence,
}

const GATE: &str = "admission.lock";
const DATABASE: &str = "recovery.sqlite3";

pub(super) struct Coordinator {
    inner: Mutex<Inner>,
}

struct Inner {
    root_path: PathBuf,
    root: Directory,
    root_identity: ObjectId,
    gate: File,
    gate_identity: ObjectId,
    catalog: Catalog,
    locks: Directory,
    locks_identity: ObjectId,
    database: File,
    database_identity: ObjectId,
    protected: Resource,
    journal: Journal,
    poisoned: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReservationRecord {
    version: u32,
    resources: Vec<Resource>,
    lock: LockIdentity,
}

/// Holds resource ownership across filesystem work without holding admission or
/// the database mutex. Abandoned guards leave a reclaimable row and close the OS
/// lock; their destructors never remove user data or recovery evidence.
pub(super) struct Reservation {
    coordinator: Arc<Coordinator>,
    owner: OperationLock,
    id: String,
    generation: u64,
    resources: Vec<Resource>,
    request_count: usize,
}

impl Coordinator {
    /// Read immutable discovery intent without opening SQLite or probing any
    /// user/artifact paths. A lost or corrupt index cannot hide an intact catalog.
    /// This grants no recovery action; callers still need claimed inspection.
    pub(super) fn discover_catalog(path: &Path) -> Result<Vec<DurableIntent>, AppError> {
        super::native_path::validate(path).map_err(invalid)?;
        // Match initialization's parent canonicalization (macOS commonly has
        // /var -> /private/var). The recovery root itself remains no-follow.
        let parent = match fs::canonicalize(path.parent().expect("validated entry parent")) {
            Ok(parent) => parent,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let path = &parent.join(path.file_name().expect("validated entry name"));
        let root = match Directory::open(path) {
            Ok(root) => root,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        validate_private_directory(&root)?;
        let root_identity = of_file(&root.file)?;
        let gate = root.open_file(OsStr::new(GATE))?;
        validate_file(&gate)?;
        let gate_identity = of_file(&gate)?;
        let _admission = FileLock::acquire(gate)?;
        verify_named_directory(path, root_identity)?;
        verify_entry(&root, GATE, gate_identity)?;
        let catalog = Catalog::open(root.open_existing(OsStr::new("catalog"))?)?;
        let protected =
            resources::capture(path, resources::Access::Read, resources::Scope::Subtree)?;
        let mut intents: Vec<_> = decode_catalog(&catalog.records()?, &protected)?
            .into_values()
            .map(|entry| entry.intent)
            .collect();
        verify_named_directory(path, root_identity)?;
        validate_private_directory(&root)?;
        verify_entry(&root, GATE, gate_identity)?;
        let named_catalog = root.open_existing(OsStr::new("catalog"))?;
        validate_private_directory(&named_catalog)?;
        if of_file(&named_catalog.file)? != catalog.identity()? {
            return Err(invalid(
                "Recovery catalog changed during discovery; evidence is preserved",
            ));
        }
        intents.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(intents)
    }

    /// Caller chooses an app-local root. Call from blocking work only, after
    /// core-ready discovery or on the first actual mutation, never Tauri setup.
    pub(super) fn open(path: &Path) -> Result<Arc<Self>, AppError> {
        let parent_path = fs::canonicalize(
            path.parent()
                .ok_or_else(|| invalid("Recovery storage requires a parent"))?,
        )?;
        let parent = Directory::open(&parent_path)?;
        let name = path
            .file_name()
            .ok_or_else(|| invalid("Recovery storage requires a directory name"))?;
        let root = open_private_directory(&parent, name)?;
        let root_path = parent_path.join(name);
        let root_identity = of_file(&root.file)?;
        let gate = match root.open_file(OsStr::new(GATE)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if !root.names(1)?.is_empty() {
                    // Another initializer may have published the gate after
                    // our failed open. Use that gate; never create a replacement
                    // in a populated root whose gate is actually missing.
                    root.open_file(OsStr::new(GATE)).map_err(|error| {
                        if error.kind() == std::io::ErrorKind::NotFound {
                            invalid("Recovery admission lock is missing; existing evidence is preserved")
                        } else { error.into() }
                    })?
                } else {
                    match root.create_file(OsStr::new(GATE)) {
                        Ok(file) => {
                            file.sync_all()?;
                            root.sync()?;
                            file
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            root.open_file(OsStr::new(GATE))?
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            }
            Err(error) => return Err(error.into()),
        };
        validate_file(&gate)?;
        let gate_identity = of_file(&gate)?;
        let admission = root.open_file(OsStr::new(GATE))?;
        verify_opened_entry(&admission, gate_identity)?;
        let _admission = FileLock::acquire(admission)?;
        verify_named_directory(&root_path, root_identity)?;
        verify_entry(&root, GATE, gate_identity)?;
        let existed = root.entry_exists(OsStr::new(DATABASE))?;
        let child = |name: &str| -> Result<Directory, AppError> {
            if existed {
                Ok(root.open_existing(OsStr::new(name))?)
            } else {
                open_private_directory(&root, OsStr::new(name))
            }
        };
        let catalog = Catalog::open(child("catalog")?)?;
        let locks = child("locks")?;
        validate_private_directory(&locks)?;
        let locks_identity = of_file(&locks.file)?;
        // New DB creation is anchor-relative and exclusive. Never let SQLite
        // follow a replaced name or silently create an unrelated missing index.
        let database = if existed {
            root.open_file(OsStr::new(DATABASE))?
        } else {
            if !catalog.records()?.is_empty() || !locks.names(MAX_RECORDS + 1)?.is_empty() {
                return Err(invalid(
                    "Recovery index is missing; catalog and owner evidence are preserved",
                ));
            }
            let file = root.create_file(OsStr::new(DATABASE))?;
            file.sync_all()?;
            root.sync()?;
            file
        };
        validate_file(&database)?;
        let database_identity = of_file(&database)?;
        verify_entry(&root, DATABASE, database_identity)?;
        let journal = Journal::open_existing(&root_path.join(DATABASE))?;
        verify_named_directory(&root_path, root_identity)?;
        verify_entry(&root, DATABASE, database_identity)?;
        let protected = resources::capture(
            &root_path,
            resources::Access::Read,
            resources::Scope::Subtree,
        )?;
        Ok(Arc::new(Self {
            inner: Mutex::new(Inner {
                root_path,
                root,
                root_identity,
                gate,
                gate_identity,
                catalog,
                locks,
                locks_identity,
                database,
                database_identity,
                protected,
                journal,
                poisoned: None,
            }),
        }))
    }

    fn admitted<T>(
        &self,
        work: impl FnOnce(&mut Inner) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| invalid("Recovery coordinator failed; mutation is fenced"))?;
        if let Some(error) = &inner.poisoned {
            return Err(invalid(error));
        }
        // A cloned Windows handle is not a new lock contender. Capture and
        // verify a fresh open description, then recheck the namespace under it.
        let admission = inner
            .root
            .open_file(OsStr::new(GATE))
            .map_err(AppError::from)
            .and_then(|file| {
                verify_opened_entry(&file, inner.gate_identity)?;
                Ok(file)
            });
        let admission = match admission {
            Ok(file) => file,
            Err(error) => {
                inner.poisoned = Some(error.to_string());
                return Err(error);
            }
        };
        let _admission = FileLock::acquire(admission)?;
        if let Err(error) = inner.verify() {
            inner.poisoned = Some(error.to_string());
            return Err(error);
        }
        let result = work(&mut inner);
        if let Err(error) = inner.verify() {
            let message = format!("Recovery storage changed during a journal operation: {error}; outcome requires reconciliation");
            inner.poisoned = Some(message.clone());
            return Err(AppError::MutationUncertain(message));
        }
        result
    }
}

impl Reservation {
    pub(super) fn paths(&self) -> impl Iterator<Item = &Path> {
        self.resources
            .iter()
            .take(self.request_count)
            .map(|resource| resource.path.0.as_path())
    }

    pub(super) fn finish(self) -> Result<(), AppError> {
        let Self {
            coordinator,
            owner,
            id,
            generation,
            resources,
            request_count: _,
        } = self;
        coordinator.admitted(move |inner| {
            let evidence = inner.catalog.records()?;
            let intents = decode_catalog(&evidence, &inner.protected)?;
            let rows = inner.journal.records()?;
            let row = rows
                .iter()
                .find(|row| {
                    row.id == id
                        && row.generation == generation
                        && row.kind == RecordKind::Reservation
                })
                .ok_or_else(|| invalid("Recovery reservation was replaced"))?;
            let record: ReservationRecord = decode(&row.payload)?;
            validate_reservation(&row.id, &record)?;
            if record.lock != owner.identity || record.resources != resources {
                return Err(invalid("Recovery reservation owner changed"));
            }
            inner.journal.remove(&id, generation)?;
            // An operation record/catalog can retain the same lock after its
            // ordinary reservation finishes. Such locks remain actionable.
            let still_referenced = intents
                .values()
                .any(|entry| entry.intent.lock == owner.identity)
                || rows
                    .iter()
                    .filter(|row| row.id != id)
                    .any(|row| match row.kind {
                        RecordKind::Operation => decode_checkpoint(row, &intents)
                            .map_or(true, |_| intents[&row.id].intent.lock == owner.identity),
                        RecordKind::Reservation => decode::<ReservationRecord>(&row.payload)
                            .map_or(true, |record| record.lock == owner.identity),
                    });
            if !still_referenced {
                owner.retire(&inner.locks)?;
            }
            Ok(())
        })
    }
}

impl Inner {
    fn verify(&self) -> Result<(), AppError> {
        verify_named_directory(&self.root_path, self.root_identity)?;
        validate_private_directory(&self.root)?;
        verify_opened_entry(&self.gate, self.gate_identity)?;
        verify_entry(&self.root, GATE, self.gate_identity)?;
        verify_entry(&self.root, DATABASE, self.database_identity)?;
        validate_file(&self.database)?;
        let catalog = self.root.open_existing(OsStr::new("catalog"))?;
        validate_private_directory(&catalog)?;
        if of_file(&catalog.file)? != self.catalog.identity()? {
            return Err(invalid("Recovery catalog directory was replaced"));
        }
        let locks = self.root.open_existing(OsStr::new("locks"))?;
        if of_file(&locks.file)? != self.locks_identity {
            return Err(invalid("Recovery owner directory was replaced"));
        }
        validate_private_directory(&locks)?;
        Ok(())
    }

    fn retire_unreferenced(&self, referenced: &HashSet<String>) -> Result<(), AppError> {
        for name in self.locks.names(MAX_RECORDS + 1)? {
            if name.to_str().is_some_and(|name| referenced.contains(name)) {
                continue;
            }
            match OperationLock::acquire_unreferenced(&self.locks, &name)? {
                LockAttempt::Acquired(owner) => owner.retire(&self.locks)?,
                LockAttempt::Busy => {
                    return Err(invalid(
                        "An unindexed recovery owner is still active; mutation is fenced",
                    ))
                }
            }
        }
        Ok(())
    }
}

struct CatalogIntent {
    intent: DurableIntent,
    digest: [u8; 32],
}

fn decode_checkpoint(
    row: &super::journal::Record,
    catalog: &HashMap<String, CatalogIntent>,
) -> Result<OperationCheckpoint, AppError> {
    let entry = catalog.get(&row.id).ok_or_else(|| {
        invalid("Recovery checkpoint has no catalog evidence; mutation is fenced")
    })?;
    let checkpoint: OperationCheckpoint = decode(&row.payload)?;
    checkpoint.validate(&entry.intent, entry.digest)?;
    Ok(checkpoint)
}

fn decode_catalog(
    evidence: &[Evidence],
    protected: &Resource,
) -> Result<HashMap<String, CatalogIntent>, AppError> {
    let mut protected_index = ConflictIndex::default();
    protected_index.insert(protected);
    let mut intents = HashMap::new();
    for item in evidence {
        let intent: DurableIntent = decode(&item.payload)?;
        intent.validate()?;
        if intent
            .resources
            .iter()
            .any(|resource| protected_index.conflicts(resource))
        {
            return Err(invalid(
                "Recovery intent attempts to mutate protected application storage",
            ));
        }
        if intent.id != item.id {
            return Err(invalid("Recovery catalog ID disagrees with its intent"));
        }
        intents.insert(
            item.id.clone(),
            CatalogIntent {
                intent,
                digest: item.digest(),
            },
        );
    }
    Ok(intents)
}

fn validate_reservation(id: &str, record: &ReservationRecord) -> Result<(), AppError> {
    if record.version != 1 || record.lock.name != format!("{id}.lock") {
        return Err(invalid("Recovery reservation identity is invalid"));
    }
    resources::validate(&record.resources)?;
    super::locks::validate_identity(&record.lock)?;
    Ok(())
}

fn decode<T: serde::de::DeserializeOwned>(payload: &[u8]) -> Result<T, AppError> {
    serde_json::from_slice(payload)
        .map_err(|_| invalid("Recovery record cannot be decoded; evidence is preserved"))
}

fn open_private_directory(parent: &Directory, name: &OsStr) -> Result<Directory, AppError> {
    let directory = match parent.open_existing(name) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match parent.create_directory(name) {
                Ok(directory) => {
                    directory.sync()?;
                    parent.sync()?;
                    directory
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    parent.open_existing(name)?
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    };
    validate_private_directory(&directory)?;
    Ok(directory)
}

fn verify_named_directory(path: &Path, expected: ObjectId) -> Result<(), AppError> {
    if of_file(&Directory::open(path)?.file)? != expected {
        return Err(invalid("Recovery storage namespace was replaced"));
    }
    Ok(())
}

fn verify_entry(directory: &Directory, name: &str, expected: ObjectId) -> Result<(), AppError> {
    let file = directory.open_file(OsStr::new(name))?;
    verify_opened_entry(&file, expected)
}

fn verify_opened_entry(file: &File, expected: ObjectId) -> Result<(), AppError> {
    validate_file(file)?;
    if of_file(file)? != expected {
        return Err(invalid("Recovery storage entry was replaced"));
    }
    Ok(())
}

fn invalid(message: &str) -> AppError {
    AppError::Other(message.to_owned())
}

#[cfg(test)]
#[path = "../../../test_support/recovery_coordinator.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../test_support/recovery_move_intent.rs"]
mod move_intent_tests;
