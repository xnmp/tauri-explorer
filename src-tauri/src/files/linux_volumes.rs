//! UDisks2 discovery supplements the mount table; only an explicit click mounts.
use super::drives::{Drive, DriveKind};
use crate::error::AppError;
use std::{collections::HashMap, path::Path, time::Duration};
use zbus::{fdo::ManagedObjects, zvariant::OwnedValue, Connection};

const SERVICE: &str = "org.freedesktop.UDisks2";
const ROOT: &str = "/org/freedesktop/UDisks2";
const BLOCK: &str = "org.freedesktop.UDisks2.Block";
const FILESYSTEM: &str = "org.freedesktop.UDisks2.Filesystem";
const DISK: &str = "org.freedesktop.UDisks2.Drive";
type Properties = HashMap<String, OwnedValue>;

fn string<'a>(properties: &'a Properties, key: &str) -> Option<&'a str> {
    properties.get(key).and_then(|v| <&str>::try_from(v).ok())
}
fn flag(properties: &Properties, key: &str) -> bool {
    properties
        .get(key)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false)
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

fn volumes(objects: &ManagedObjects) -> Vec<Drive> {
    let mut drives = Vec::new();
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
        let path = mount_path(filesystem).unwrap_or_default();
        if !path.is_empty() && super::drives::is_linux_system_mount(&path) {
            continue;
        }
        let name = string(block, "IdLabel")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| id.as_str().rsplit('/').next().unwrap_or("Removable volume"));
        drives.push(Drive {
            name: name.into(),
            path,
            kind: DriveKind::Removable,
            device_id: Some(id.to_string()),
            detail: None,
            provider: None,
        });
    }
    drives.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    drives
}

async fn objects(connection: &Connection) -> Result<ManagedObjects, AppError> {
    tokio::time::timeout(Duration::from_secs(2), async {
        let proxy = zbus::fdo::ObjectManagerProxy::builder(connection)
            .destination(SERVICE)?
            .path(ROOT)?
            .build()
            .await?;
        proxy.get_managed_objects().await.map_err(zbus::Error::from)
    })
    .await
    .map_err(|_| AppError::Other("Linux storage service (UDisks2) timed out".into()))?
    .map_err(|e| AppError::Other(format!("Linux storage service (UDisks2) unavailable: {e}")))
}
async fn system_connection() -> Result<Connection, AppError> {
    tokio::time::timeout(Duration::from_secs(2), Connection::system())
        .await
        .map_err(|_| {
            AppError::Other("Linux storage service (UDisks2) connection timed out".into())
        })?
        .map_err(|e| AppError::Other(format!("Linux storage service (UDisks2) unavailable: {e}")))
}

fn merge_with_mountinfo(
    mounted: &mut Vec<Drive>,
    desktop: Vec<Drive>,
    objects: &ManagedObjects,
    mountinfo: &str,
) {
    let mounts = super::drives::parse_linux_mounts(mountinfo);
    for volume in desktop {
        let source = volume
            .device_id
            .as_ref()
            .and_then(|id| zbus::zvariant::ObjectPath::try_from(id.as_str()).ok())
            .and_then(|id| objects.get(&id))
            .and_then(|i| i.get(BLOCK))
            .and_then(|p| p.get("Device"))
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| Vec::<u8>::try_from(v).ok())
            .and_then(|mut bytes| {
                if bytes.last() == Some(&0) {
                    bytes.pop();
                }
                String::from_utf8(bytes).ok()
            });
        let source_paths: Vec<_> = mounts
            .iter()
            .filter(|m| source.as_deref() == Some(&m.source))
            .map(|m| m.path.clone())
            .collect();
        // Match both snapshots by device source; UDisks supplies the newer mount
        // state, including an empty path after an external unmount.
        mounted.retain(|d| {
            !(source_paths.contains(&d.path) || !volume.path.is_empty() && d.path == volume.path)
        });
        mounted.push(volume);
    }
}

pub(super) async fn supplement(mut mounted: Vec<Drive>, mountinfo: &str) -> Vec<Drive> {
    let Ok(connection) = system_connection().await else {
        return mounted;
    };
    match objects(&connection).await {
        Ok(objects) => {
            merge_with_mountinfo(&mut mounted, volumes(&objects), &objects, mountinfo);
            mounted
        }
        Err(_) => mounted, // UDisks is optional: retain mounted and cloud discovery.
    }
}

/// Shared native discovery seam for deterministic mount-table/sysfs/D-Bus fixtures.
#[doc(hidden)]
pub async fn enumerate_with_connection(
    mountinfo: &str,
    sys_block: &Path,
    labels: &Path,
    connection: Option<&Connection>,
) -> Vec<Drive> {
    let mut mounted =
        super::drives::parse_linux_block_mounts_with_labels(mountinfo, sys_block, labels);
    if let Some(connection) = connection {
        if let Ok(objects) = objects(connection).await {
            merge_with_mountinfo(&mut mounted, volumes(&objects), &objects, mountinfo);
        }
    }
    mounted
}

pub(super) async fn mount(device_id: &str) -> Result<String, AppError> {
    mount_with_connection(&system_connection().await?, device_id).await
}

/// The same D-Bus adapter used by mount_drive, with an injectable bus for tests.
#[doc(hidden)]
pub async fn mount_with_connection(
    connection: &Connection,
    device_id: &str,
) -> Result<String, AppError> {
    if !device_id.starts_with("/org/freedesktop/UDisks2/block_devices/") {
        return Err(AppError::Other("Invalid removable volume identity".into()));
    }
    let available = volumes(&objects(connection).await?);
    let volume = available
        .iter()
        .find(|v| v.device_id.as_deref() == Some(device_id))
        .ok_or_else(|| AppError::Other("Removable volume is no longer available".into()))?;
    if !volume.path.is_empty() {
        return Ok(volume.path.clone());
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
                if let Some(volume) = volumes(&objects)
                    .into_iter()
                    .find(|v| v.device_id.as_deref() == Some(device_id) && !v.path.is_empty())
                {
                    return Ok(volume.path);
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
