//! UDisks2 discovery supplements the mount table; only an explicit click mounts.
//!
//! Discovery reads the cached snapshot of one long-lived subscription
//! (`linux_volume_monitor`), so polling `list_drives` never touches the bus.
use super::drives::{Drive, DriveKind};
use super::linux_gvfs_watch::GvfsWatch;
use super::linux_mount_watch::{host_mount_table_drives, MountTableWatch};
use super::linux_volume_monitor::{Discovery, MonitorConfig, VolumeMonitor};
use crate::error::AppError;
use serde::Serialize;
use std::{collections::HashMap, path::Path, sync::OnceLock, time::Duration};
use tauri::{AppHandle, Emitter, Runtime};
use zbus::{fdo::ManagedObjects, zvariant::OwnedValue, Connection};

pub(super) const SERVICE: &str = "org.freedesktop.UDisks2";
pub(super) const ROOT: &str = "/org/freedesktop/UDisks2";
const BLOCK: &str = "org.freedesktop.UDisks2.Block";
const FILESYSTEM: &str = "org.freedesktop.UDisks2.Filesystem";
const DISK: &str = "org.freedesktop.UDisks2.Drive";
/// Frontend event emitted whenever discovered volumes or liveness change.
pub const DRIVES_CHANGED_EVENT: &str = "drives-changed";
type Properties = HashMap<String, OwnedValue>;

/// One eligible UDisks filesystem volume and its block-device source, which
/// joins it to the process mount table.
#[derive(Debug, Clone, PartialEq)]
pub struct Volume {
    pub drive: Drive,
    source: Option<String>,
}

fn string<'a>(properties: &'a Properties, key: &str) -> Option<&'a str> {
    properties.get(key).and_then(|v| <&str>::try_from(v).ok())
}
fn flag(properties: &Properties, key: &str) -> bool {
    properties
        .get(key)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false)
}
fn bytes_string(properties: &Properties, key: &str) -> Option<String> {
    let mut bytes = Vec::<u8>::try_from(properties.get(key)?.try_clone().ok()?).ok()?;
    if bytes.last() == Some(&0) {
        bytes.pop();
    }
    String::from_utf8(bytes).ok()
}
fn mount_path(properties: &Properties) -> Option<String> {
    let value = properties.get("MountPoints")?.try_clone().ok()?;
    Vec::<Vec<u8>>::try_from(value)
        .ok()?
        .into_iter()
        .find_map(|mut bytes| {
            if bytes.last() == Some(&0) {
                bytes.pop();
            }
            String::from_utf8(bytes)
                .ok()
                .filter(|path| valid_mount_path(path))
        })
}
fn valid_mount_path(path: &str) -> bool {
    path.starts_with('/') && !path.contains('\0')
}

/// Eligible removable filesystem volumes in a UDisks snapshot, by identity.
pub(super) fn volumes(objects: &ManagedObjects) -> Vec<Volume> {
    let mut found = Vec::new();
    for (id, interfaces) in objects {
        let Some(block) = interfaces.get(BLOCK) else {
            continue;
        };
        let Some(filesystem) = interfaces.get(FILESYSTEM) else {
            continue;
        };
        if flag(block, "HintIgnore") || string(block, "IdUsage") != Some("filesystem") {
            continue;
        }
        let Some(disk_id) = block
            .get("Drive")
            .and_then(|v| <&zbus::zvariant::ObjectPath>::try_from(v).ok())
        else {
            continue;
        };
        let Some(disk) = objects.get(disk_id).and_then(|i| i.get(DISK)) else {
            continue;
        };
        // USB hard disks often report Removable=false, just like on Windows.
        if !flag(disk, "Removable")
            && !flag(disk, "MediaRemovable")
            && string(disk, "ConnectionBus") != Some("usb")
        {
            continue;
        }
        let path = mount_path(filesystem);
        if path
            .as_deref()
            .is_some_and(super::drives::is_linux_system_mount)
        {
            continue;
        }
        let name = string(block, "IdLabel")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| id.as_str().rsplit('/').next().unwrap_or("Removable volume"));
        found.push(Volume {
            drive: Drive {
                name: name.into(),
                path,
                kind: DriveKind::Removable,
                device_id: Some(id.to_string()),
                detail: None,
                provider: None,
            },
            source: bytes_string(block, "Device"),
        });
    }
    found.sort_by(|a, b| a.drive.device_id.cmp(&b.drive.device_id));
    found
}

pub(super) enum FetchError {
    /// No reply within the two-second discovery deadline.
    TimedOut,
    Bus(zbus::Error),
}

/// One `GetManagedObjects` round trip on an existing connection.
pub(super) async fn fetch_objects(connection: &Connection) -> Result<ManagedObjects, FetchError> {
    let fetch = async {
        let proxy = zbus::fdo::ObjectManagerProxy::builder(connection)
            .destination(SERVICE)?
            .path(ROOT)?
            .build()
            .await?;
        proxy.get_managed_objects().await.map_err(zbus::Error::from)
    };
    match tokio::time::timeout(Duration::from_secs(2), fetch).await {
        Ok(result) => result.map_err(FetchError::Bus),
        Err(_) => Err(FetchError::TimedOut),
    }
}
async fn objects(connection: &Connection) -> Result<ManagedObjects, AppError> {
    fetch_objects(connection).await.map_err(|e| match e {
        FetchError::TimedOut => AppError::Other("Linux storage service (UDisks2) timed out".into()),
        FetchError::Bus(e) => {
            AppError::Other(format!("Linux storage service (UDisks2) unavailable: {e}"))
        }
    })
}
async fn session_connection() -> Result<Connection, AppError> {
    tokio::time::timeout(Duration::from_secs(2), Connection::session())
        .await
        .map_err(|_| AppError::Other("Session bus connection timed out".into()))?
        .map_err(|e| AppError::Other(format!("Session bus unavailable: {e}")))
}
async fn system_connection() -> Result<Connection, AppError> {
    tokio::time::timeout(Duration::from_secs(2), Connection::system())
        .await
        .map_err(|_| {
            AppError::Other("Linux storage service (UDisks2) connection timed out".into())
        })?
        .map_err(|e| AppError::Other(format!("Linux storage service (UDisks2) unavailable: {e}")))
}

/// Merge the original mount-table snapshot with UDisks by device source and
/// mount path. The newer UDisks mount state wins, including an unmounted path
/// after an external unmount, so one volume never becomes two rows.
fn merge_with_mountinfo(mounted: &mut Vec<Drive>, desktop: &[Volume], mountinfo: &str) {
    let mounts = super::drives::parse_linux_mounts(mountinfo);
    for volume in desktop {
        let source_paths: Vec<_> = mounts
            .iter()
            .filter(|m| volume.source.as_deref() == Some(&m.source))
            .map(|m| m.path.as_str())
            .collect();
        mounted.retain(|d| {
            let Some(path) = d.path.as_deref() else {
                return true;
            };
            !(source_paths.contains(&path) || volume.drive.path.as_deref() == Some(path))
        });
        mounted.push(volume.drive.clone());
    }
}

/// Apply the subscription's discovery to mount-table drives. Unavailable
/// UDisks keeps mounted and cloud discovery unchanged (ADR 0025).
async fn merge_discovery(
    mut mounted: Vec<Drive>,
    mountinfo: &str,
    monitor: &VolumeMonitor,
) -> Vec<Drive> {
    if let Discovery::Live(volumes) = monitor.discovery().await {
        merge_with_mountinfo(&mut mounted, &volumes, mountinfo);
    }
    mounted
}

static MONITOR: OnceLock<VolumeMonitor> = OnceLock::new();

#[derive(Clone, Serialize)]
struct DrivesChanged {
    /// Set only by the UDisks monitor, the sole liveness reporter: true while
    /// its subscription pushes changes. Other sources omit it, so a push they
    /// race with a liveness transition can never report a stale value.
    #[serde(skip_serializing_if = "Option::is_none")]
    live: Option<bool>,
}

static MOUNT_WATCH: OnceLock<MountTableWatch> = OnceLock::new();
static GVFS_WATCH: OnceLock<GvfsWatch> = OnceLock::new();

fn announce<R: Runtime>(app: &AppHandle<R>, live: Option<bool>) {
    if let Err(error) = app.emit(DRIVES_CHANGED_EVENT, DrivesChanged { live }) {
        log::warn!("Failed to announce drive changes: {error}");
    }
}

/// Register the process-wide change sources, which emit `drives-changed` to
/// every window: the UDisks monitor (connected on the first discovery
/// request), the mount-table watch for mounts UDisks never reports, and the
/// GVfs mount tracker for GVfs entries no mount table shows.
pub fn init_monitor<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let monitor = VolumeMonitor::new(MonitorConfig::default(), system_connection, move |live| {
        announce(&handle, Some(live))
    });
    if MONITOR.set(monitor).is_err() {
        log::warn!("Linux volume monitor initialized more than once");
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let dir = super::drives::linux_gvfs_dir();
        match GvfsWatch::start(session_connection(), dir, move || announce(&handle, None)).await {
            Ok(watch) => {
                let _ = GVFS_WATCH.set(watch);
            }
            Err(error) => log::warn!("GVfs mount changes will not be pushed: {error}"),
        }
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let notify = move || announce(&handle, None);
        match MountTableWatch::spawn(
            Path::new("/proc/self/mountinfo"),
            host_mount_table_drives,
            notify,
        ) {
            Ok(watch) => {
                let _ = MOUNT_WATCH.set(watch);
            }
            // The frontend's backstop poll still covers the mount table.
            Err(error) => log::warn!("Mount-table changes will not be pushed: {error}"),
        }
    });
}

pub(super) async fn supplement(mounted: Vec<Drive>, mountinfo: &str) -> Vec<Drive> {
    match MONITOR.get() {
        Some(monitor) => merge_discovery(mounted, mountinfo, monitor).await,
        None => mounted,
    }
}

/// Whether drive changes are currently pushed to the frontend.
pub(super) fn updates_live() -> bool {
    MONITOR.get().is_some_and(VolumeMonitor::is_live)
}

/// The production merge over a monitor's cached discovery, parameterized over
/// mount-table/sysfs/D-Bus fixtures. Exercised directly by this module's own
/// tests (`test_support/linux_removable_volumes.rs`, #926); no production
/// caller needs it since `supplement` fixes the real mount table and sysfs,
/// so it is test-only rather than a `#[doc(hidden)] pub` seam.
#[cfg(test)]
async fn enumerate_with_monitor(
    mountinfo: &str,
    sys_block: &Path,
    labels: &Path,
    monitor: Option<&VolumeMonitor>,
) -> Vec<Drive> {
    let mounted = super::drives::parse_linux_block_mounts_with_labels(mountinfo, sys_block, labels);
    match monitor {
        Some(monitor) => merge_discovery(mounted, mountinfo, monitor).await,
        None => mounted,
    }
}

pub(super) async fn mount(device_id: &str) -> Result<String, AppError> {
    match MONITOR.get() {
        Some(monitor) => mount_with_monitor(monitor, device_id).await,
        None => mount_with_connection(&system_connection().await?, device_id).await,
    }
}

/// Mount on the monitor's connection, then resynchronize so the caller's next
/// discovery already reflects the outcome (mounted, or raced by another client).
async fn mount_with_monitor(monitor: &VolumeMonitor, device_id: &str) -> Result<String, AppError> {
    let connection = match monitor.connection() {
        Some(connection) => connection,
        None => system_connection().await?,
    };
    let result = mount_with_connection(&connection, device_id).await;
    monitor.resync().await;
    result
}

/// The same D-Bus adapter used by mount_drive, with an injectable bus for tests.
async fn mount_with_connection(
    connection: &Connection,
    device_id: &str,
) -> Result<String, AppError> {
    if !device_id.starts_with("/org/freedesktop/UDisks2/block_devices/") {
        return Err(AppError::Other("Invalid removable volume identity".into()));
    }
    // Mount authority always comes from a fresh snapshot, never the cache.
    let available = volumes(&objects(connection).await?);
    let volume = available
        .iter()
        .find(|v| v.drive.device_id.as_deref() == Some(device_id))
        .ok_or_else(|| AppError::Other("Removable volume is no longer available".into()))?;
    if let Some(path) = &volume.drive.path {
        return Ok(path.clone());
    }
    let proxy = zbus::Proxy::new(connection, SERVICE, device_id, FILESYSTEM)
        .await
        .map_err(|e| AppError::Other(format!("Cannot access removable volume: {e}")))?;
    let options: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::new();
    let result: Result<String, _> =
        tokio::time::timeout(Duration::from_secs(120), proxy.call("Mount", &(options,)))
            .await
            .map_err(|_| {
                AppError::Other(
                    "Mount request timed out; refresh the drives before trying again".into(),
                )
            })?;
    let path = match result {
        Ok(path) => path,
        Err(error) => {
            // Another desktop client may have mounted it since our discovery.
            if let Ok(objects) = objects(connection).await {
                if let Some(path) = volumes(&objects)
                    .into_iter()
                    .filter(|v| v.drive.device_id.as_deref() == Some(device_id))
                    .find_map(|v| v.drive.path)
                {
                    return Ok(path);
                }
            }
            return Err(AppError::Other(format!(
                "Cannot mount removable volume: {error}"
            )));
        }
    };
    if !valid_mount_path(&path) {
        return Err(AppError::Other(
            "Storage service returned an invalid mount path".into(),
        ));
    }
    Ok(path)
}

/// Production UDisks2 adapter against an isolated D-Bus daemon (#677, #888).
/// Moved in from Cargo's auto-discovered `tests/linux_removable_volumes.rs`
/// (#926) so it can reach `enumerate_with_monitor`/`mount_with_monitor`/
/// `mount_with_connection` directly instead of through `#[doc(hidden)] pub`
/// seams. Per CLAUDE.md (#677), this still exercises the production adapter,
/// never a fake.
#[cfg(test)]
#[path = "../../test_support/linux_removable_volumes.rs"]
mod tests;
