#![cfg(target_os = "linux")]
//! Production UDisks2 adapter against an isolated D-Bus daemon (#677, #888).
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri_explorer_lib::{
    error::AppError,
    files::{
        linux_volume_monitor::{MonitorConfig, VolumeMonitor},
        linux_volumes::{enumerate_with_monitor, mount_with_connection, mount_with_monitor},
    },
};
use tokio::sync::mpsc;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

type Properties = HashMap<String, OwnedValue>;
type Interfaces = HashMap<String, Properties>;
type Objects = HashMap<OwnedObjectPath, Interfaces>;
const SERVICE: &str = "org.freedesktop.UDisks2";
const ROOT: &str = "/org/freedesktop/UDisks2";
const ID: &str = "/org/freedesktop/UDisks2/block_devices/sdb1";
const DISK: &str = "/org/freedesktop/UDisks2/drives/usb";
const BLOCK: &str = "org.freedesktop.UDisks2.Block";
const FILESYSTEM: &str = "org.freedesktop.UDisks2.Filesystem";
const MOUNTED_TABLE: &str = "42 35 8:17 / /media/USB\\040Backup rw - ext4 /dev/sdb1 rw\n";

// Fixture states: volume unmounted, mounted, removed, mount denied, bad path.
const UNMOUNTED: usize = 0;
const MOUNTED: usize = 1;
const REMOVED: usize = 2;
const DENIED: usize = 3;
const INVALID_PATH: usize = 4;

fn val<T: Into<Value<'static>>>(value: T) -> OwnedValue {
    OwnedValue::try_from(value.into()).unwrap()
}
fn path(value: &str) -> OwnedObjectPath {
    OwnedObjectPath::try_from(value).unwrap()
}
fn mount_points(state: usize) -> OwnedValue {
    val(if state == MOUNTED {
        vec![b"/media/USB Backup\0".to_vec()]
    } else {
        vec![]
    })
}
fn disk_interfaces() -> Interfaces {
    HashMap::from([(
        "org.freedesktop.UDisks2.Drive".into(),
        HashMap::from([
            ("Removable".into(), val(false)),
            ("ConnectionBus".into(), val("usb")),
        ]),
    )])
}
fn volume_interfaces(state: usize) -> Interfaces {
    HashMap::from([
        (
            BLOCK.into(),
            HashMap::from([
                ("Device".into(), val(b"/dev/sdb1\0".to_vec())),
                ("Drive".into(), val(path(DISK))),
                ("IdLabel".into(), val(r"USB Backup\x20")),
                ("IdUsage".into(), val("filesystem")),
                ("HintIgnore".into(), val(false)),
            ]),
        ),
        (
            FILESYSTEM.into(),
            HashMap::from([("MountPoints".into(), mount_points(state))]),
        ),
    ])
}
fn objects(state: usize) -> Objects {
    let mut objects = HashMap::from([(path(DISK), disk_interfaces())]);
    if state != REMOVED {
        objects.insert(path(ID), volume_interfaces(state));
    }
    objects
}

struct Manager {
    state: Arc<AtomicUsize>,
    snapshots: Arc<AtomicUsize>,
}
#[zbus::interface(name = "org.freedesktop.DBus.ObjectManager")]
impl Manager {
    fn get_managed_objects(&self) -> Objects {
        self.snapshots.fetch_add(1, Ordering::SeqCst);
        objects(self.state.load(Ordering::SeqCst))
    }
}
struct Filesystem {
    state: Arc<AtomicUsize>,
    calls: Arc<AtomicUsize>,
}
#[zbus::interface(name = "org.freedesktop.UDisks2.Filesystem")]
impl Filesystem {
    fn mount(&self, _options: HashMap<String, OwnedValue>) -> zbus::fdo::Result<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.state.load(Ordering::SeqCst) {
            DENIED => Err(zbus::fdo::Error::AccessDenied(
                "Not authorized to mount USB Backup".into(),
            )),
            INVALID_PATH => Ok("relative/path".into()),
            _ => {
                // Like udisksd's reply, but deliberately without a signal.
                self.state.store(MOUNTED, Ordering::SeqCst);
                Ok("/media/USB Backup".into())
            }
        }
    }
}

struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
/// An isolated dbus-daemon with a fake UDisks2 service on it.
struct Bus {
    _daemon: Daemon,
    address: String,
    server: zbus::Connection,
    state: Arc<AtomicUsize>,
    calls: Arc<AtomicUsize>,
    snapshots: Arc<AtomicUsize>,
}
impl Bus {
    async fn start() -> Self {
        let mut child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut address = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        let address = address.trim().to_owned();
        let state = Arc::new(AtomicUsize::new(UNMOUNTED));
        let calls = Arc::new(AtomicUsize::new(0));
        let snapshots = Arc::new(AtomicUsize::new(0));
        let server = zbus::connection::Builder::address(address.as_str())
            .unwrap()
            .name(SERVICE)
            .unwrap()
            .serve_at(
                ROOT,
                Manager {
                    state: state.clone(),
                    snapshots: snapshots.clone(),
                },
            )
            .unwrap()
            .serve_at(
                ID,
                Filesystem {
                    state: state.clone(),
                    calls: calls.clone(),
                },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        Self {
            _daemon: Daemon(child),
            address,
            server,
            state,
            calls,
            snapshots,
        }
    }
    async fn client(&self) -> zbus::Connection {
        zbus::connection::Builder::address(self.address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap()
    }
    async fn emit<B: serde::Serialize + zbus::zvariant::DynamicType>(
        &self,
        object: &str,
        interface: &str,
        member: &str,
        body: &B,
    ) {
        self.server
            .emit_signal(None::<&str>, object, interface, member, body)
            .await
            .unwrap();
    }
    /// Change mount state the way udisksd announces it.
    async fn set_mounted(&self, mounted: bool) {
        let state = if mounted { MOUNTED } else { UNMOUNTED };
        self.state.store(state, Ordering::SeqCst);
        let changed = HashMap::from([("MountPoints".to_owned(), mount_points(state))]);
        let invalidated: Vec<String> = vec![];
        self.emit(
            ID,
            "org.freedesktop.DBus.Properties",
            "PropertiesChanged",
            &(FILESYSTEM, changed, invalidated),
        )
        .await;
    }
    async fn remove_volume(&self) {
        self.state.store(REMOVED, Ordering::SeqCst);
        self.emit(
            ROOT,
            "org.freedesktop.DBus.ObjectManager",
            "InterfacesRemoved",
            &(path(ID), vec![BLOCK, FILESYSTEM]),
        )
        .await;
    }
    async fn insert_volume(&self) {
        self.state.store(UNMOUNTED, Ordering::SeqCst);
        self.emit(
            ROOT,
            "org.freedesktop.DBus.ObjectManager",
            "InterfacesAdded",
            &(path(ID), volume_interfaces(UNMOUNTED)),
        )
        .await;
    }
}

/// A monitor like production's, but connecting to the current isolated bus
/// and reporting each connection attempt and change notification.
struct Harness {
    monitor: VolumeMonitor,
    connects: Arc<AtomicUsize>,
    changes: mpsc::UnboundedReceiver<bool>,
    address: Arc<Mutex<String>>,
    reachable: Arc<AtomicBool>,
}
fn harness(bus: &Bus, backstop: Duration) -> Harness {
    let connects = Arc::new(AtomicUsize::new(0));
    let address = Arc::new(Mutex::new(bus.address.clone()));
    let reachable = Arc::new(AtomicBool::new(true));
    let (notify, changes) = mpsc::unbounded_channel();
    let config = MonitorConfig {
        backstop,
        retry: Duration::from_millis(50),
        first_sync: Duration::from_secs(3),
    };
    let (count, target, up) = (connects.clone(), address.clone(), reachable.clone());
    let monitor = VolumeMonitor::new(
        config,
        move || {
            count.fetch_add(1, Ordering::SeqCst);
            let address = target.lock().unwrap().clone();
            let up = up.load(Ordering::SeqCst);
            async move {
                if !up {
                    return Err(AppError::Other("no system bus".into()));
                }
                zbus::connection::Builder::address(address.as_str())
                    .map_err(|e| AppError::Other(e.to_string()))?
                    .build()
                    .await
                    .map_err(|e| AppError::Other(e.to_string()))
            }
        },
        move |live| {
            let _ = notify.send(live);
        },
    );
    Harness {
        monitor,
        connects,
        changes,
        address,
        reachable,
    }
}
const QUIET: Duration = Duration::from_secs(60);
impl Harness {
    async fn discover(&self, mounts: &str) -> Vec<tauri_explorer_lib::files::drives::Drive> {
        let sys = tempfile::tempdir().unwrap();
        let labels = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(sys.path().join("sdb/sdb1")).unwrap();
        std::fs::write(sys.path().join("sdb/removable"), "0").unwrap();
        enumerate_with_monitor(mounts, sys.path(), labels.path(), Some(&self.monitor)).await
    }
    /// The next pushed change, which must arrive without any polling.
    async fn changed(&mut self) -> bool {
        tokio::time::timeout(Duration::from_secs(5), self.changes.recv())
            .await
            .expect("drive change was not pushed")
            .unwrap()
    }
    async fn assert_quiet(&mut self) {
        let next = tokio::time::timeout(Duration::from_millis(300), self.changes.recv()).await;
        assert!(next.is_err(), "unexpected drive notification: {next:?}");
    }
}

#[tokio::test]
async fn subscription_pushes_mount_unmount_removal_and_insertion_over_one_connection() {
    let bus = Bus::start().await;
    let mut h = harness(&bus, QUIET);
    let before = h.discover("").await;
    assert!(h.changed().await, "first snapshot announces a live feed");
    assert_eq!(
        before.len(),
        1,
        "unmounted USB HDD must appear before Thunar opens it"
    );
    assert_eq!(
        before[0].name, r"USB Backup\x20",
        "UDisks labels are already decoded"
    );
    assert_eq!(before[0].path, None, "unmounted volumes have no route");
    assert_eq!(before[0].device_id.as_deref(), Some(ID));
    let wire = serde_json::to_value(&before[0]).unwrap();
    assert_eq!(wire["kind"], "removable");
    assert_eq!(wire["path"], serde_json::Value::Null);
    assert_eq!(wire["deviceId"], ID, "IPC fields are camelCase");

    bus.set_mounted(true).await;
    assert!(h.changed().await);
    let mounted = h.discover(MOUNTED_TABLE).await;
    assert_eq!(mounted.len(), 1, "mount table and UDisks merge to one row");
    assert_eq!(mounted[0].device_id.as_deref(), Some(ID));
    assert_eq!(mounted[0].path.as_deref(), Some("/media/USB Backup"));

    bus.set_mounted(false).await;
    assert!(h.changed().await);
    let unmounted = h.discover(MOUNTED_TABLE).await;
    assert_eq!(
        unmounted.len(),
        1,
        "unmount between snapshots must not duplicate the volume"
    );
    assert_eq!(unmounted[0].path, None, "newer desktop mount state wins");

    bus.remove_volume().await;
    assert!(h.changed().await);
    assert!(h.discover("").await.is_empty());
    bus.insert_volume().await;
    assert!(h.changed().await);
    assert_eq!(h.discover("").await.len(), 1, "insertion is pushed");

    // Property churn that does not alter any volume (SMART data, drive stats)
    // must not wake every window.
    let changed = HashMap::from([("TimeMediaDetected".to_owned(), val(7u64))]);
    let invalidated: Vec<String> = vec![];
    bus.emit(
        DISK,
        "org.freedesktop.DBus.Properties",
        "PropertiesChanged",
        &("org.freedesktop.UDisks2.Drive", changed, invalidated),
    )
    .await;
    h.assert_quiet().await;

    for _ in 0..50 {
        assert_eq!(h.discover("").await.len(), 1);
    }
    assert_eq!(
        h.connects.load(Ordering::SeqCst),
        1,
        "steady state reuses one connection"
    );
    assert_eq!(
        bus.snapshots.load(Ordering::SeqCst),
        1,
        "signals update the cache; discovery never refetches"
    );
    assert_eq!(
        bus.calls.load(Ordering::SeqCst),
        0,
        "discovery must never mount"
    );
}

#[tokio::test]
async fn mounting_reuses_the_subscription_and_is_visible_to_the_next_discovery() {
    let bus = Bus::start().await;
    let mut h = harness(&bus, QUIET);
    assert_eq!(h.discover("").await[0].path, None);
    assert!(h.changed().await);
    assert_eq!(
        mount_with_monitor(&h.monitor, ID).await.unwrap(),
        "/media/USB Backup"
    );
    // The fake service sends no signal: the post-mount resync is what makes
    // the mounted state visible to the sidebar's immediate refresh.
    let mounted = h.discover(MOUNTED_TABLE).await;
    assert_eq!(mounted.len(), 1);
    assert_eq!(mounted[0].path.as_deref(), Some("/media/USB Backup"));
    assert_eq!(
        mount_with_monitor(&h.monitor, ID).await.unwrap(),
        "/media/USB Backup"
    );
    assert_eq!(
        bus.calls.load(Ordering::SeqCst),
        1,
        "already mounted volumes open directly"
    );
    assert_eq!(h.connects.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn backstop_resync_corrects_a_change_no_signal_described() {
    let bus = Bus::start().await;
    let mut h = harness(&bus, Duration::from_millis(150));
    assert_eq!(h.discover("").await[0].path, None);
    assert!(h.changed().await);
    bus.state.store(MOUNTED, Ordering::SeqCst);
    assert!(h.changed().await, "backstop resync announces the change");
    assert_eq!(
        h.discover(MOUNTED_TABLE).await[0].path.as_deref(),
        Some("/media/USB Backup")
    );
    assert_eq!(h.connects.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unreachable_or_lost_bus_falls_back_to_the_mount_table_and_recovers() {
    let bus = Bus::start().await;
    let mut h = harness(&bus, QUIET);
    h.reachable.store(false, Ordering::SeqCst);
    let fallback = h.discover(MOUNTED_TABLE).await;
    assert!(!h.changed().await, "fallback is announced as not live");
    assert!(!h.monitor.is_live());
    assert_eq!(
        fallback.len(),
        1,
        "mounted discovery survives without a bus"
    );
    assert_eq!(fallback[0].path.as_deref(), Some("/media/USB Backup"));
    assert_eq!(fallback[0].device_id, None);

    h.reachable.store(true, Ordering::SeqCst);
    assert!(h.changed().await, "a returning bus is picked up by retry");
    assert_eq!(h.discover("").await[0].device_id.as_deref(), Some(ID));

    // The system bus goes away: the live connection is lost, and discovery
    // falls back until a restarted bus accepts the reconnection.
    h.reachable.store(false, Ordering::SeqCst);
    drop(bus);
    assert!(!h.changed().await, "losing the bus falls back");
    assert_eq!(h.discover(MOUNTED_TABLE).await[0].device_id, None);
    let replacement = Bus::start().await;
    *h.address.lock().unwrap() = replacement.address.clone();
    let connects = h.connects.load(Ordering::SeqCst);
    h.reachable.store(true, Ordering::SeqCst);
    assert!(h.changed().await, "reconnects to the restarted bus");
    assert!(h.connects.load(Ordering::SeqCst) > connects);
    replacement.set_mounted(true).await;
    assert!(h.changed().await, "the new connection is subscribed");
    assert_eq!(
        h.discover(MOUNTED_TABLE).await[0].path.as_deref(),
        Some("/media/USB Backup")
    );
}

#[tokio::test]
async fn missing_service_keeps_mounted_discovery_until_it_returns_on_the_same_bus() {
    let bus = Bus::start().await;
    let mut h = harness(&bus, QUIET);
    assert_eq!(h.discover("").await.len(), 1);
    assert!(h.changed().await);
    bus.server.release_name(SERVICE).await.unwrap();
    assert!(!h.changed().await, "service exit is pushed");
    let drives = h.discover(MOUNTED_TABLE).await;
    assert_eq!(drives.len(), 1);
    assert_eq!(drives[0].path.as_deref(), Some("/media/USB Backup"));
    assert_eq!(drives[0].device_id, None);
    assert!(mount_with_connection(&bus.client().await, ID)
        .await
        .unwrap_err()
        .to_string()
        .contains("Linux storage service (UDisks2) unavailable"));
    bus.server.request_name(SERVICE).await.unwrap();
    assert!(h.changed().await, "service return is pushed");
    assert_eq!(h.discover("").await[0].device_id.as_deref(), Some(ID));
    assert_eq!(
        h.connects.load(Ordering::SeqCst),
        1,
        "a service restart needs no reconnect"
    );
}

#[tokio::test]
async fn native_mount_errors_and_invalid_paths_do_not_become_navigation_targets() {
    let bus = Bus::start().await;
    let client = bus.client().await;
    bus.state.store(DENIED, Ordering::SeqCst);
    assert!(mount_with_connection(&client, ID)
        .await
        .unwrap_err()
        .to_string()
        .contains("Not authorized"));
    bus.state.store(INVALID_PATH, Ordering::SeqCst);
    assert!(mount_with_connection(&client, ID).await.is_err());
    assert!(mount_with_connection(&client, "/unrelated/object")
        .await
        .is_err());
    bus.state.store(REMOVED, Ordering::SeqCst);
    assert!(
        mount_with_connection(&client, ID).await.is_err(),
        "removed object must not mount"
    );
}

#[tokio::test]
async fn fallback_decodes_udev_aliases_once_without_changing_navigation_paths() {
    let sys = tempfile::tempdir().unwrap();
    let labels = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(sys.path().join("sdb/sdb1")).unwrap();
    std::fs::write(sys.path().join("sdb/removable"), "1").unwrap();
    std::os::unix::fs::symlink("/dev/sdb1", labels.path().join(r"USB\x20Backup\x5cx20")).unwrap();
    let drives = enumerate_with_monitor(MOUNTED_TABLE, sys.path(), labels.path(), None).await;
    assert_eq!(drives.len(), 1);
    assert_eq!(drives[0].name, r"USB Backup\x20");
    assert_eq!(drives[0].path.as_deref(), Some("/media/USB Backup"));
}

#[tokio::test]
async fn encoded_unicode_and_malformed_alias_text_are_preserved_at_the_discovery_seam() {
    for (alias, expected) in [
        (r"Caf\xc3\xa9\x20Backup", "Café Backup"),
        (r"literal\xZZ\x2", r"literal\xZZ\x2"),
    ] {
        let sys = tempfile::tempdir().unwrap();
        let labels = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(sys.path().join("sdb/sdb1")).unwrap();
        std::fs::write(sys.path().join("sdb/removable"), "1").unwrap();
        std::os::unix::fs::symlink("/dev/sdb1", labels.path().join(alias)).unwrap();
        let drives = enumerate_with_monitor(
            "42 35 8:17 / /media/Backup rw - ext4 /dev/sdb1 rw\n",
            sys.path(),
            labels.path(),
            None,
        )
        .await;
        assert_eq!(drives[0].name, expected);
        assert_eq!(drives[0].path.as_deref(), Some("/media/Backup"));
    }
}
