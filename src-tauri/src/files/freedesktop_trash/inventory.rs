//! Read-only enumeration of every Freedesktop trash the user can restore from:
//! the home trash plus `$topdir/.Trash/$uid` and `$topdir/.Trash-$uid` on each
//! mount. Each listed item carries the exact artifact the restore engine
//! verifies, so a later restore refuses metadata or payloads that changed.
use super::{identity, version_at, Directory, INFO_SUFFIX, MAX_INFO_BYTES};
use crate::files::{
    trash_artifact::TrashArtifact,
    trash_inventory::{Inventory, Item, Restorable, TrashEntry, TrashIssue},
    trash_mounts::{Mount, MountSnapshot},
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashSet},
    ffi::{OsStr, OsString},
    io::Read,
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::MetadataExt,
    },
    path::{Component, Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

/// Kernel, virtual and read-only image filesystems never hold a user trash;
/// probing some of them (autofs) can also block or trigger automounts.
const PSEUDO_FILESYSTEMS: &[&str] = &[
    "autofs",
    "binfmt_misc",
    "bpf",
    "cgroup",
    "cgroup2",
    "configfs",
    "debugfs",
    "devpts",
    "devtmpfs",
    "efivarfs",
    "fusectl",
    "hugetlbfs",
    "mqueue",
    "nsfs",
    "proc",
    "pstore",
    "rpc_pipefs",
    "securityfs",
    "selinuxfs",
    "squashfs",
    "sysfs",
    "tracefs",
];

/// Upper bound on items read from one trash directory, so a pathological
/// trash cannot exhaust memory while the view is opened.
const MAX_ITEMS_PER_SOURCE: usize = 100_000;

/// One trash directory and the top directory its relative paths resolve from.
#[derive(Clone, Debug)]
pub(crate) struct Source {
    pub root: PathBuf,
    /// `None` for the home trash, whose metadata paths must be absolute.
    pub topdir: Option<PathBuf>,
}

/// The per-user trash directories a mount's top directory holds (spec).
pub(crate) fn mount_sources(top: &Path) -> Vec<Source> {
    let uid = unsafe { libc::geteuid() };
    let mut sources = Vec::new();
    let shared = top.join(".Trash");
    // The shared .Trash must be a sticky real directory; a symlink or a
    // non-sticky directory is not a valid trash.
    if std::fs::symlink_metadata(&shared)
        .is_ok_and(|meta| meta.is_dir() && meta.mode() & libc::S_ISVTX != 0)
    {
        let root = shared.join(uid.to_string());
        if std::fs::symlink_metadata(&root).is_ok_and(|meta| meta.is_dir()) {
            sources.push(Source {
                root,
                topdir: Some(top.to_owned()),
            });
        }
    }
    let root = top.join(format!(".Trash-{uid}"));
    if std::fs::symlink_metadata(&root).is_ok_and(|meta| meta.is_dir()) {
        sources.push(Source {
            root,
            topdir: Some(top.to_owned()),
        });
    }
    sources
}

fn probes(mount: &Mount) -> bool {
    !PSEUDO_FILESYSTEMS
        .iter()
        .any(|name| mount.filesystem.as_bytes() == name.as_bytes())
}

/// Scanned sources keyed by trash directory identity, for bind-mount dedupe.
pub(crate) type Scanned = Vec<(Option<(u64, u64)>, Inventory)>;

pub(crate) fn scan_keyed(sources: &[Source]) -> Scanned {
    sources
        .iter()
        .map(|source| {
            let key = std::fs::metadata(&source.root)
                .ok()
                .map(|meta| (meta.dev(), meta.ino()));
            let mut inventory = Inventory::default();
            scan(source, &mut inventory);
            (key, inventory)
        })
        .collect()
}

/// Bind mounts that expose the same trash twice are listed once.
fn merge(scanned: Scanned, seen: &mut HashSet<(u64, u64)>, into: &mut Inventory) {
    for (key, inventory) in scanned {
        if key.is_some_and(|key| !seen.insert(key)) {
            continue;
        }
        into.items.extend(inventory.items);
        into.issues.extend(inventory.issues);
    }
}

/// Scan sources in order, listing a trash reached twice only once.
#[cfg(test)]
pub(crate) fn scan_sources(sources: &[Source], inventory: &mut Inventory) {
    merge(scan_keyed(sources), &mut HashSet::new(), inventory);
}

/// Mount points whose probe thread has not finished yet.
static PROBING: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

/// How long the listing waits for mounted volumes; a stale network mount can
/// block a stat indefinitely.
const MOUNT_DEADLINE: Duration = Duration::from_secs(3);

/// Enumerate the user's trash directories on this host. The home trash is
/// read first and never waits for other volumes.
pub(crate) fn list() -> Inventory {
    let mut inventory = Inventory::default();
    let Some(data_home) = dirs::data_dir().filter(|path| path.is_absolute()) else {
        inventory.issues.push(TrashIssue {
            source: "Trash".into(),
            error: "The XDG data directory is unavailable, so the home trash cannot be read".into(),
        });
        return inventory;
    };
    let mut seen = HashSet::new();
    let home = Source {
        root: data_home.join("Trash"),
        topdir: None,
    };
    merge(scan_keyed(&[home]), &mut seen, &mut inventory);
    match MountSnapshot::read() {
        Ok(mounts) => scan_mounts(
            &mounts,
            MOUNT_DEADLINE,
            |top| scan_keyed(&mount_sources(top)),
            &mut seen,
            &mut inventory,
        ),
        Err(error) => inventory.issues.push(TrashIssue {
            source: "Mounted volumes".into(),
            error: format!("Trash on other volumes could not be found: {error}"),
        }),
    }
    inventory
}

/// Probe every mount in parallel. A volume that does not answer before
/// `deadline` is reported and skipped; its probe thread is abandoned rather
/// than holding the listing (a blocked stat cannot be cancelled).
pub(crate) fn scan_mounts(
    mounts: &MountSnapshot,
    deadline: Duration,
    probe: impl Fn(&Path) -> Scanned + Clone + Send + 'static,
    seen: &mut HashSet<(u64, u64)>,
    inventory: &mut Inventory,
) {
    let started = Instant::now();
    let mut pending = Vec::new();
    for mount in mounts.mounts().iter().filter(|mount| probes(mount)) {
        let top = mount.mount_point.clone();
        // A probe still blocked from an earlier listing is not repeated, so
        // refreshing while a mount hangs does not accumulate threads.
        if !PROBING
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .insert(top.clone())
        {
            inventory.issues.push(TrashIssue {
                source: top.display().to_string(),
                error: "This volume is still not responding, so its trash is not shown".into(),
            });
            continue;
        }
        let (sender, receiver) = mpsc::channel();
        let probe = probe.clone();
        let task = top.clone();
        let spawned = std::thread::Builder::new()
            .name("trash-mount-probe".into())
            .spawn(move || {
                let scanned = probe(&task);
                PROBING
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .remove(&task);
                let _ = sender.send(scanned);
            });
        if spawned.is_err() {
            PROBING
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&top);
        }
        match spawned {
            Ok(_) => pending.push((top, receiver)),
            Err(error) => inventory.issues.push(TrashIssue {
                source: top.display().to_string(),
                error: format!("Could not check this volume's trash: {error}"),
            }),
        }
    }
    for (top, receiver) in pending {
        match receiver.recv_timeout(deadline.saturating_sub(started.elapsed())) {
            Ok(scanned) => merge(scanned, seen, inventory),
            Err(_) => inventory.issues.push(TrashIssue {
                source: top.display().to_string(),
                error: "This volume did not respond in time, so its trash is not shown".into(),
            }),
        }
    }
}

/// Add one trash directory's valid items and summarize what was skipped.
/// A missing home trash is simply empty; every other failure is reported
/// without discarding entries already read from other sources.
pub(crate) fn scan(source: &Source, inventory: &mut Inventory) {
    let label = source.root.display().to_string();
    let directory = match Directory::open(&source.root) {
        Ok(directory) => directory,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            inventory.issues.push(TrashIssue {
                source: label,
                error: format!("Could not open this trash: {error}"),
            });
            return;
        }
    };
    let opened = directory
        .open_existing(OsStr::new("info"))
        .and_then(|info| Ok((info, directory.open_existing(OsStr::new("files"))?)));
    let (info, files) = match opened {
        Ok(opened) => opened,
        // A trash that was never used has no layout yet.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            inventory.issues.push(TrashIssue {
                source: label,
                error: format!("Could not read this trash: {error}"),
            });
            return;
        }
    };
    let names = match info.names(MAX_ITEMS_PER_SOURCE + 1) {
        Ok(names) => names,
        Err(error) => {
            inventory.issues.push(TrashIssue {
                source: label,
                error: format!("Could not list this trash's records: {error}"),
            });
            return;
        }
    };
    if names.len() > MAX_ITEMS_PER_SOURCE {
        inventory.issues.push(TrashIssue {
            source: label.clone(),
            error: format!("Only the first {MAX_ITEMS_PER_SOURCE} items are shown"),
        });
    }
    let mut unreadable = 0usize;
    let mut first_error = None;
    for info_file in names.into_iter().take(MAX_ITEMS_PER_SOURCE) {
        let Some(name) = info_file
            .as_bytes()
            .strip_suffix(INFO_SUFFIX)
            .filter(|name| !name.is_empty())
            .map(|name| OsString::from_vec(name.to_vec()))
        else {
            continue;
        };
        match read_item(source, &info, &files, &info_file, name) {
            Ok(item) => inventory.items.push(item),
            Err(error) => {
                unreadable += 1;
                first_error.get_or_insert(error);
            }
        }
    }
    if let Some(error) = first_error {
        inventory.issues.push(TrashIssue {
            source: label,
            error: if unreadable == 1 {
                format!("1 item could not be read: {error}")
            } else {
                format!("{unreadable} items could not be read; the first failed with: {error}")
            },
        });
    }
}

fn read_item(
    source: &Source,
    info: &Directory,
    files: &Directory,
    info_file: &OsStr,
    name: OsString,
) -> Result<Item, String> {
    let mut file = info
        .open_file(info_file)
        .map_err(|error| format!("{}: {error}", info_file.to_string_lossy()))?;
    let stat = file
        .metadata()
        .map_err(|error| format!("{}: {error}", info_file.to_string_lossy()))?;
    if !stat.is_file() {
        return Err(format!("{} is not a file", info_file.to_string_lossy()));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_INFO_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("{}: {error}", info_file.to_string_lossy()))?;
    if bytes.len() as u64 > MAX_INFO_BYTES {
        return Err(format!("{} is too large", info_file.to_string_lossy()));
    }
    let parsed = parse_trash_info(&bytes)
        .ok_or_else(|| format!("{} has malformed metadata", info_file.to_string_lossy()))?;
    let original = match (&source.topdir, parsed.path.is_absolute()) {
        (_, true) => parsed.path,
        (Some(topdir), false) => topdir.join(parsed.path),
        (None, false) => {
            return Err(format!(
                "{} records a relative path in the home trash",
                info_file.to_string_lossy()
            ))
        }
    };
    if original.file_name().is_none()
        || original
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(format!(
            "{} records an invalid original path",
            info_file.to_string_lossy()
        ));
    }
    let payload = version_at(files, &name).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!(
                "{} has no matching file in the trash",
                info_file.to_string_lossy()
            )
        } else {
            format!("{}: {error}", name.to_string_lossy())
        }
    })?;
    // Restoration compares the request against the resolved original path.
    let resolved = super::resolved_restore_path(&original).unwrap_or_else(|_| original.clone());
    let display_name = original
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let entry = TrashEntry {
        id: super::super::trash_inventory::entry_id(&[
            source.root.as_os_str().as_bytes(),
            name.as_bytes(),
            &serde_json::to_vec(&payload).map_err(|error| error.to_string())?,
            &stat.ctime().to_le_bytes(),
            &stat.ctime_nsec().to_le_bytes(),
        ]),
        name: display_name,
        original_path: Some(original.to_string_lossy().into_owned()),
        deleted_at: parsed.deleted_at,
        kind: if payload.directory {
            "directory"
        } else {
            "file"
        },
        size: if payload.directory { 0 } else { payload.size },
        is_symlink: payload.symlink,
    };
    let artifact = TrashArtifact::Freedesktop {
        root: source.root.clone(),
        name,
        original_path: resolved,
        metadata_digest: Sha256::digest(&bytes).into(),
        metadata_identity: identity(&stat),
        payload_version: payload,
    };
    Ok(Item {
        entry,
        native_deletion: None,
        restore: Some(Restorable {
            key: original.to_string_lossy().into_owned(),
            destination: original,
            artifact: Arc::new(artifact),
        }),
    })
}

#[derive(Debug, PartialEq)]
pub(crate) struct TrashInfo {
    pub path: PathBuf,
    /// RFC 3339 in local time; `None` when absent or unparsable.
    pub deleted_at: Option<String>,
}

/// Parse the `[Trash Info]` group. `Path` is required; a missing or invalid
/// `DeletionDate` leaves the item restorable without a deletion time.
pub(crate) fn parse_trash_info(bytes: &[u8]) -> Option<TrashInfo> {
    let mut in_group = false;
    let mut path = None;
    let mut deleted_at = None;
    for line in bytes.split(|byte| *byte == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() || line.starts_with(b"#") {
            continue;
        }
        if line.starts_with(b"[") {
            in_group = line == b"[Trash Info]";
            continue;
        }
        if !in_group {
            continue;
        }
        if let Some(value) = line.strip_prefix(b"Path=") {
            if path.is_none() {
                path = Some(percent_decode(value)?);
            }
        } else if let Some(value) = line.strip_prefix(b"DeletionDate=") {
            deleted_at = std::str::from_utf8(value).ok().and_then(local_rfc3339);
        }
    }
    let path = path.filter(|path: &Vec<u8>| !path.is_empty() && !path.contains(&0))?;
    Some(TrashInfo {
        path: PathBuf::from(OsString::from_vec(path)),
        deleted_at,
    })
}

fn percent_decode(value: &[u8]) -> Option<Vec<u8>> {
    let mut decoded = Vec::with_capacity(value.len());
    let mut bytes = value.iter();
    while let Some(byte) = bytes.next() {
        if *byte == b'%' {
            let high = (*bytes.next()? as char).to_digit(16)?;
            let low = (*bytes.next()? as char).to_digit(16)?;
            decoded.push((high * 16 + low) as u8);
        } else {
            decoded.push(*byte);
        }
    }
    Some(decoded)
}

fn local_rfc3339(value: &str) -> Option<String> {
    use chrono::TimeZone;
    let naive = chrono::NaiveDateTime::parse_from_str(value.trim(), "%Y-%m-%dT%H:%M:%S").ok()?;
    chrono::Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|time| time.to_rfc3339())
}

#[cfg(test)]
#[path = "../../../test_support/freedesktop_trash_inventory.rs"]
mod tests;
