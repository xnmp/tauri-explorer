//! The in-app Trash location (#863): enumerate the platform's real trash and
//! restore selected items through the exact-artifact restore engine.
//!
//! The renderer only ever sees opaque entry IDs. Each listing registers the
//! natively captured artifact behind its ID, and restore resolves IDs back to
//! those artifacts; the renderer cannot supply a trash location or receipt
//! (ADR 0019). Restore refuses occupied destinations and missing parents
//! before any effect, and the engine re-verifies the artifact before moving it.
use super::batch::{FileBatchOutcome, FileFailure};
use super::trash_artifact::{RestoreRequest, TrashArtifact};
use crate::error::AppError;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
};

/// One trashed item as the Trash view presents it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// Stable across listings while the item stays in the same trash slot.
    pub id: String,
    /// The original file name, not the trash's collision-avoiding name.
    pub name: String,
    pub original_path: Option<String>,
    /// RFC 3339; `None` when the platform did not record it.
    pub deleted_at: Option<String>,
    pub kind: &'static str,
    pub size: u64,
    pub is_symlink: bool,
}

/// A trash source (or some of its records) that could not be read. Other
/// sources' entries are still listed.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct TrashIssue {
    pub source: String,
    pub error: String,
}

#[derive(Debug, Serialize)]
pub struct TrashListing {
    pub entries: Vec<TrashEntry>,
    pub issues: Vec<TrashIssue>,
}

pub(crate) struct Item {
    pub entry: TrashEntry,
    /// `None` when the platform did not record where the item came from.
    pub restore: Option<Restorable>,
}

/// Where a listed item restores to. Checks use the native destination;
/// the display key only names the item in the batch outcome.
#[derive(Clone)]
pub(crate) struct Restorable {
    pub key: String,
    pub destination: PathBuf,
    pub artifact: Arc<TrashArtifact>,
}

#[derive(Default)]
pub(crate) struct Inventory {
    pub items: Vec<Item>,
    pub issues: Vec<TrashIssue>,
}

type Registry = HashMap<String, Option<Restorable>>;

/// Artifacts from the most recent listing, keyed by entry ID.
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Default::default);

/// Opaque, stable ID from the parts that locate an item in its trash.
pub(crate) fn entry_id(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part);
    }
    hex::encode(&hasher.finalize()[..16])
}

/// Register a fresh inventory and return its renderer projection.
pub(crate) fn publish(inventory: Inventory) -> TrashListing {
    let mut registry = REGISTRY.lock().unwrap_or_else(|poison| poison.into_inner());
    registry.clear();
    let entries = inventory
        .items
        .into_iter()
        .map(|item| {
            registry.insert(item.entry.id.clone(), item.restore);
            item.entry
        })
        .collect();
    TrashListing {
        entries,
        issues: inventory.issues,
    }
}

/// List every trash source on this host.
pub async fn list() -> Result<TrashListing, AppError> {
    let inventory = super::run_blocking(|| Ok(platform_inventory())).await?;
    Ok(publish(inventory))
}

#[tauri::command]
pub async fn list_trash() -> Result<TrashListing, AppError> {
    list().await
}

fn platform_inventory() -> Inventory {
    #[cfg(target_os = "linux")]
    {
        super::freedesktop_trash::inventory::list()
    }
    #[cfg(target_os = "windows")]
    {
        windows_inventory()
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        macos_inventory()
    }
}

#[cfg(target_os = "windows")]
fn windows_inventory() -> Inventory {
    use std::os::windows::ffi::OsStrExt;
    let mut inventory = Inventory::default();
    let items = match trash::os_limited::list() {
        Ok(items) => items,
        Err(error) => {
            inventory.issues.push(TrashIssue {
                source: "Recycle Bin".into(),
                error: format!("Could not read the Recycle Bin: {error}"),
            });
            return inventory;
        }
    };
    for item in items {
        let parsing_name: Vec<u16> = item.id.encode_wide().collect();
        if parsing_name.is_empty() || parsing_name.contains(&0) {
            continue;
        }
        let (kind, size) = match trash::os_limited::metadata(&item).map(|metadata| metadata.size) {
            Ok(trash::TrashItemSize::Entries(_)) => ("directory", 0),
            Ok(trash::TrashItemSize::Bytes(bytes)) => ("file", bytes),
            Err(_) => ("file", 0),
        };
        let original = item.original_path().to_string_lossy().into_owned();
        let id_bytes: Vec<u8> = parsing_name
            .iter()
            .flat_map(|unit| unit.to_le_bytes())
            .collect();
        inventory.items.push(Item {
            entry: TrashEntry {
                id: entry_id(&[&id_bytes]),
                name: item.name.to_string_lossy().into_owned(),
                original_path: Some(original.clone()),
                deleted_at: chrono::DateTime::from_timestamp(item.time_deleted, 0)
                    .map(|time| time.with_timezone(&chrono::Local).to_rfc3339()),
                kind,
                size,
                is_symlink: false,
            },
            restore: Some(Restorable {
                key: original,
                destination: item.original_path(),
                artifact: Arc::new(TrashArtifact::WindowsShell {
                    parsing_name_utf16: parsing_name,
                }),
            }),
        });
    }
    inventory
}

/// macOS keeps original locations private to Finder; items Tauri Explorer
/// trashed itself restore through its own deletion record (#863).
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn macos_inventory() -> Inventory {
    let Some(root) = dirs::home_dir().map(|home| home.join(".Trash")) else {
        let mut inventory = Inventory::default();
        inventory.issues.push(TrashIssue {
            source: "Trash".into(),
            error: "The home directory is unavailable".into(),
        });
        return inventory;
    };
    let records = super::trash_origins::Store::default_location()
        .map(|store| store.load())
        .unwrap_or_default();
    recorded_inventory(&root, &records)
}

/// List a trash folder whose origins come only from Tauri Explorer's own
/// deletion records; other items are listed without a restore destination.
#[cfg(unix)]
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub(crate) fn recorded_inventory(
    root: &Path,
    records: &[super::trash_origins::Record],
) -> Inventory {
    use std::os::unix::ffi::OsStrExt;
    let mut inventory = Inventory::default();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return inventory,
        Err(error) => {
            inventory.issues.push(TrashIssue {
                source: root.display().to_string(),
                error: if error.kind() == std::io::ErrorKind::PermissionDenied {
                    "macOS denied access to the Trash. Allow Full Disk Access for Tauri Explorer in System Settings > Privacy & Security.".into()
                } else {
                    format!("Could not read the Trash: {error}")
                },
            });
            return inventory;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == ".DS_Store" {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let record = records
            .iter()
            .find(|record| record.trashed == path && record.matches(&metadata));
        inventory.items.push(Item {
            entry: TrashEntry {
                id: entry_id(&[path.as_os_str().as_bytes()]),
                // A same-named item already in the Trash makes the system
                // rename this one; show the name it will be restored under.
                name: record
                    .and_then(|record| record.original.file_name())
                    .unwrap_or(&name)
                    .to_string_lossy()
                    .into_owned(),
                original_path: record.map(|record| record.original.to_string_lossy().into_owned()),
                deleted_at: record.map(|record| record.deleted_at.clone()),
                kind: if metadata.is_dir() {
                    "directory"
                } else {
                    "file"
                },
                size: if metadata.is_dir() { 0 } else { metadata.len() },
                is_symlink: metadata.file_type().is_symlink(),
            },
            restore: record.map(|record| Restorable {
                key: record.original.to_string_lossy().into_owned(),
                destination: record.original.clone(),
                artifact: Arc::new(TrashArtifact::Recorded {
                    trashed: record.trashed.clone(),
                    original: record.original.clone(),
                    device: record.device,
                    inode: record.inode,
                    deleted_at: record.deleted_at.clone(),
                }),
            }),
        });
    }
    inventory
}

/// Resolve IDs into engine requests. Every refusal here happens before any
/// filesystem effect and leaves the item in the trash.
pub(crate) fn plan_restore(ids: &[String]) -> (Vec<RestoreRequest>, Vec<FileFailure>) {
    plan_restore_in(
        &REGISTRY.lock().unwrap_or_else(|poison| poison.into_inner()),
        ids,
    )
}

fn plan_restore_in(registry: &Registry, ids: &[String]) -> (Vec<RestoreRequest>, Vec<FileFailure>) {
    let mut requests = Vec::new();
    let mut failures = Vec::new();
    let mut destinations = HashSet::new();
    for id in ids {
        let Some(registered) = registry.get(id) else {
            failures.push(FileFailure {
                path: id.clone(),
                error: "This item is no longer in the trash list. Refresh the Trash and try again."
                    .into(),
            });
            continue;
        };
        let Some(Restorable {
            key,
            destination,
            artifact,
        }) = registered
        else {
            failures.push(FileFailure {
                path: id.clone(),
                error: "The original location of this item was not recorded, so it cannot be restored here. Move it out of the Trash instead.".into(),
            });
            continue;
        };
        if let Err(error) = restorable(destination) {
            failures.push(FileFailure {
                path: key.clone(),
                error,
            });
            continue;
        }
        if !destinations.insert(destination.clone()) {
            failures.push(FileFailure {
                path: key.clone(),
                error: format!(
                    "Another selected item is being restored to {}. Restore them one at a time.",
                    destination.display()
                ),
            });
            continue;
        }
        requests.push(RestoreRequest {
            path: key.clone(),
            artifact: Arc::clone(artifact),
        });
    }
    (requests, failures)
}

/// A restore never replaces an existing entry or invents a missing folder.
fn restorable(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            return Err(format!(
                "{} already exists. Rename or move it, then restore again.",
                path.display()
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot check {}: {error}", path.display())),
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| format!("{} has no original folder", path.display()))?;
    match std::fs::metadata(parent) {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(format!("{} is no longer a folder", parent.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(format!(
            "The original folder {} no longer exists or its drive is not mounted. Restore or recreate that folder first.",
            parent.display()
        )),
        Err(error) => Err(format!("Cannot open {}: {error}", parent.display())),
    }
}

/// Restore the listed items. Pre-checked refusals join the engine's per-item
/// outcome so one blocked item does not prevent the others.
pub(crate) async fn restore(
    ids: Vec<String>,
    runtime: &super::admission::Runtime,
) -> Result<FileBatchOutcome, AppError> {
    let (requests, refused) = plan_restore(&ids);
    let mut outcome = if requests.is_empty() {
        FileBatchOutcome::default()
    } else {
        super::trash::restore_to_existing_parents(requests, runtime).await?
    };
    outcome.failed.extend(refused);
    Ok(outcome)
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../../test_support/trash_inventory.rs"]
mod tests;

#[cfg(all(test, not(target_os = "linux")))]
#[path = "../../test_support/trash_inventory_native.rs"]
mod native_tests;
