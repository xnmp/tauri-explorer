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
    #[cfg(unix)]
    pub native_deletion: Option<NativeDeletion>,
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

#[derive(Clone)]
struct Registered {
    restore: Option<Restorable>,
    #[cfg(unix)]
    native_deletion: Option<NativeDeletion>,
}

/// macOS lists entries without origin records too; permanent deletion still
/// retains their exact native identity, independently of restore eligibility.
#[cfg(unix)]
#[derive(Clone)]
pub(crate) struct NativeDeletion {
    path: PathBuf,
    version: super::entry_version::EntryVersion,
    changed_seconds: i64,
    changed_nanos: i64,
}

type Registry = HashMap<String, Registered>;

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
            registry.insert(
                item.entry.id.clone(),
                Registered {
                    restore: item.restore,
                    #[cfg(unix)]
                    native_deletion: item.native_deletion,
                },
            );
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
    let mut names = match windows_original_names() {
        Ok(names) => names,
        Err(error) => {
            inventory.issues.push(TrashIssue {
                source: "Recycle Bin".into(),
                error: format!("Could not read original Recycle Bin names: {error}"),
            });
            return inventory;
        }
    };
    for mut item in items {
        let parsing_name: Vec<u16> = item.id.encode_wide().collect();
        if parsing_name.is_empty() || parsing_name.contains(&0) {
            continue;
        }
        // trash::list uses SIGDN_PARENTRELATIVE, whose display name can hide
        // extensions. Never use it to construct a restore destination.
        item.name = match names
            .remove(&parsing_name)
            .unwrap_or_else(|| Err("the item is no longer in the Recycle Bin".into()))
        {
            Ok(name) => name,
            Err(error) => {
                inventory.issues.push(TrashIssue {
                    source: "Recycle Bin".into(),
                    error: format!(
                        "Could not read the original name of {:?}: {error}",
                        item.name
                    ),
                });
                continue;
            }
        };
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

#[cfg(target_os = "windows")]
type WindowsOriginalNames = HashMap<Vec<u16>, Result<std::ffi::OsString, String>>;

#[cfg(target_os = "windows")]
fn windows_original_names() -> Result<WindowsOriginalNames, String> {
    use windows::{
        core::Interface,
        Win32::{
            System::Com::CoTaskMemFree,
            UI::Shell::{
                BHID_EnumItems, FOLDERID_RecycleBinFolder, IEnumShellItems, IShellItem,
                IShellItem2, SHGetKnownFolderItem, KF_FLAG_DEFAULT, SIGDN_DESKTOPABSOLUTEPARSING,
            },
        },
    };

    // trash::list initialized COM on this thread. Query the namespace items
    // themselves: reopening their parsing paths produces filesystem items
    // whose FileName is the physical $R... payload, not the original name.
    let bin: IShellItem =
        unsafe { SHGetKnownFolderItem(&FOLDERID_RecycleBinFolder, KF_FLAG_DEFAULT, None) }
            .map_err(|error| error.to_string())?;
    let enumeration: IEnumShellItems =
        unsafe { bin.BindToHandler(None, &BHID_EnumItems) }.map_err(|error| error.to_string())?;
    let mut names = HashMap::new();
    loop {
        let mut fetched = 0;
        let mut next = [None];
        unsafe { enumeration.Next(&mut next, Some(&mut fetched)) }
            .map_err(|error| error.to_string())?;
        if fetched == 0 {
            return Ok(names);
        }
        let item: IShellItem2 = next[0]
            .take()
            .ok_or("the Shell returned no enumerated item")?
            .cast()
            .map_err(|error| error.to_string())?;
        let parsing = unsafe { item.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING) }
            .map_err(|error| error.to_string())?;
        if parsing.is_null() {
            return Err("the Shell returned no item identity".into());
        }
        let key = unsafe { parsing.as_wide().to_vec() };
        unsafe { CoTaskMemFree(Some(parsing.as_ptr().cast())) };
        names.insert(key, windows_original_name(&item));
    }
}

#[cfg(target_os = "windows")]
fn windows_original_name(
    item: &windows::Win32::UI::Shell::IShellItem2,
) -> Result<std::ffi::OsString, String> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::Component};
    use windows::Win32::{Storage::EnhancedStorage::PKEY_FileName, System::Com::CoTaskMemFree};

    let value = unsafe { item.GetString(&PKEY_FileName) }.map_err(|error| error.to_string())?;
    if value.is_null() {
        return Err("the Shell did not provide an original filename".into());
    }
    let name = unsafe { OsString::from_wide(value.as_wide()) };
    unsafe { CoTaskMemFree(Some(value.as_ptr().cast())) };
    let mut components = Path::new(&name).components();
    if !matches!(components.next(), Some(Component::Normal(leaf)) if leaf == name)
        || components.next().is_some()
    {
        return Err("the Shell did not provide an original filename".into());
    }
    Ok(name)
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
    use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
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
                id: entry_id(&[
                    path.as_os_str().as_bytes(),
                    &metadata.dev().to_le_bytes(),
                    &metadata.ino().to_le_bytes(),
                    &metadata.ctime().to_le_bytes(),
                    &metadata.ctime_nsec().to_le_bytes(),
                ]),
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
            native_deletion: super::file_identity::version_from_metadata(&metadata)
                .ok()
                .map(|version| NativeDeletion {
                    path: path.clone(),
                    version,
                    changed_seconds: metadata.ctime(),
                    changed_nanos: metadata.ctime_nsec(),
                }),
            restore: record.map(|record| Restorable {
                key: record.original.to_string_lossy().into_owned(),
                destination: record.original.clone(),
                artifact: Arc::new(TrashArtifact::Recorded {
                    trashed: record.trashed.clone(),
                    original: record.original.clone(),
                    device: record.device,
                    inode: record.inode,
                    changed_seconds: record.changed_seconds,
                    changed_nanos: record.changed_nanos,
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
        }) = &registered.restore
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

/// Delete only registered IDs. Receipt keys remain opaque through settlement;
/// physical Trash paths never cross IPC and never become history actions.
pub(crate) async fn delete(
    ids: Vec<String>,
    runtime: &super::admission::Runtime,
) -> Result<FileBatchOutcome, AppError> {
    use super::batch::{self, BatchPlan};
    if ids.len() > 32_768
        || ids
            .iter()
            .try_fold(0usize, |size, id| size.checked_add(id.len()))
            .is_none_or(|size| size > 8 * 1024 * 1024)
    {
        return Err(AppError::InvalidPath(
            "Trash selection exceeds its count or size limit".into(),
        ));
    }
    let mut seen = HashSet::new();
    let ids: Vec<_> = ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    if ids.is_empty() {
        return Ok(FileBatchOutcome::default());
    }
    let registered = {
        let registry = REGISTRY.lock().unwrap_or_else(|poison| poison.into_inner());
        ids.iter()
            .map(|id| (id.clone(), registry.get(id).cloned()))
            .collect::<HashMap<_, _>>()
    };
    if registered.values().all(Option::is_none) {
        return Ok(FileBatchOutcome {
            failed: ids
                .into_iter()
                .map(|path| FileFailure {
                    path,
                    error: stale_id(),
                })
                .collect(),
            ..Default::default()
        });
    }
    let plan = BatchPlan { paths: ids };
    #[cfg(unix)]
    {
        let keys = Arc::new(plan.paths.clone());
        let prepare_registered = registered.clone();
        let prepare = move || {
            let mut auxiliary = HashSet::new();
            let entries = keys
                .iter()
                .map(|key| {
                    let entry = prepare_registered
                        .get(key)
                        .and_then(Option::as_ref)
                        .ok_or_else(stale_id)?;
                    #[cfg(target_os = "linux")]
                    if let Some(restorable) = &entry.restore {
                        auxiliary.extend(
                            super::freedesktop_trash::restoration::deletion_resources(
                                &restorable.artifact,
                            )
                            .map_err(|error| error.to_string())?,
                        );
                    }
                    if let Some(native) = &entry.native_deletion {
                        auxiliary.extend(
                            super::recovery::resources::capture_requests(&[
                                super::recovery::resources::Request {
                                    path: native.path.clone(),
                                    access: super::recovery::resources::Access::Write,
                                    scope: super::recovery::resources::Scope::Subtree,
                                },
                            ])
                            .map_err(|error| error.to_string())?,
                        );
                    }
                    deletion_source(entry)
                })
                .collect::<Vec<_>>();
            let (selection, mut resources) =
                super::permanent_delete::prepare_exact_selection(Arc::clone(&keys), &entries)?
                    .into_admission();
            resources.extend(auxiliary);
            Ok((selection, resources))
        };
        let execute = move |mut selection: super::permanent_delete::ExactSelection, owner| async move {
            Ok(batch::run_with_receipts_owned(owner, plan, move |key, _| {
                let entry = registered
                    .get(key)
                    .and_then(Option::as_ref)
                    .ok_or_else(stale_id);
                // Revalidate metadata and the listing's native identity directly
                // before the prepared engine captures its already-bound payload.
                // Consume aligned prepared refusals too, preserving later siblings.
                let verification = entry
                    .as_ref()
                    .map_err(Clone::clone)
                    .and_then(|entry| deletion_source(entry));
                if let Err(error) = verification {
                    selection.skip_next(key)?;
                    return Err(AppError::Other(error));
                }
                let entry = entry.map_err(AppError::Other)?;
                let mut success = selection.execute_next(key)?;
                if let Err(error) = cleanup_deletion(entry) {
                    let cleanup =
                        format!("Deleted item, but Trash metadata cleanup failed: {error}");
                    success.warning = Some(match success.warning {
                        Some(warning) => format!("{warning}; {cleanup}"),
                        None => cleanup,
                    });
                }
                Ok(success)
            })
            .await)
        };
        #[cfg(target_os = "linux")]
        {
            super::admission::admitted_prepared(runtime, prepare, execute).await
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = runtime;
            let (selection, _) = super::run_blocking(prepare).await?;
            execute(selection, ()).await
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = runtime;
        batch::run_dedicated_receipts(
            plan,
            super::windows_restore::StaApartment::new,
            move |apartment, key| {
                let entry = registered
                    .get(key)
                    .and_then(Option::as_ref)
                    .ok_or_else(|| AppError::Other(stale_id()))?;
                let restorable = entry
                    .restore
                    .as_ref()
                    .ok_or_else(|| AppError::Other(stale_id()))?;
                super::windows_restore::purge_exact(apartment, &restorable.artifact)
            },
        )
        .await
    }
}

fn stale_id() -> String {
    "This item is no longer in the trash list. Refresh the Trash and try again.".into()
}

#[cfg(unix)]
fn deletion_source(
    entry: &Registered,
) -> Result<(PathBuf, super::entry_version::EntryVersion), String> {
    use std::os::unix::fs::MetadataExt;
    #[cfg(target_os = "linux")]
    if let Some(restorable) = &entry.restore {
        return super::freedesktop_trash::restoration::deletion_source(&restorable.artifact)
            .map_err(|error| error.to_string());
    }
    let native = entry.native_deletion.as_ref().ok_or_else(stale_id)?;
    let metadata = std::fs::symlink_metadata(&native.path).map_err(|error| error.to_string())?;
    if metadata.ctime() != native.changed_seconds
        || metadata.ctime_nsec() != native.changed_nanos
        || super::file_identity::version_from_metadata(&metadata)
            .map_err(|error| error.to_string())?
            != native.version
    {
        return Err(
            "The item in the Trash changed since it was listed; nothing was deleted".into(),
        );
    }
    Ok((native.path.clone(), native.version.clone()))
}

#[cfg(unix)]
fn cleanup_deletion(entry: &Registered) -> Result<(), AppError> {
    #[cfg(target_os = "linux")]
    if let Some(restorable) = &entry.restore {
        return super::freedesktop_trash::restoration::cleanup_deleted(&restorable.artifact);
    }
    #[cfg(not(target_os = "linux"))]
    if let Some(native) = &entry.native_deletion {
        if let Some(store) = super::trash_origins::Store::default_location() {
            store.remove(&native.path)?;
        }
    }
    let _ = entry;
    Ok(())
}
