#![cfg(target_os = "linux")]
use std::{collections::HashMap, io::{BufRead, BufReader}, process::{Child, Command, Stdio}, sync::{Arc, atomic::{AtomicUsize, Ordering}}};
use tauri_explorer_lib::files::linux_volumes::{enumerate_with_connection, mount_with_connection};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

type Objects = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedValue>>>;
const ID: &str = "/org/freedesktop/UDisks2/block_devices/sdb1";
const DISK: &str = "/org/freedesktop/UDisks2/drives/usb";
fn val<T: Into<Value<'static>>>(value: T) -> OwnedValue { OwnedValue::try_from(value.into()).unwrap() }
struct Manager { state: Arc<AtomicUsize> }
#[zbus::interface(name = "org.freedesktop.DBus.ObjectManager")]
impl Manager {
    fn get_managed_objects(&self) -> Objects {
        let state = self.state.load(Ordering::SeqCst);
        if state == 2 { return HashMap::new(); }
        HashMap::from([
            (OwnedObjectPath::try_from(DISK).unwrap(), HashMap::from([("org.freedesktop.UDisks2.Drive".into(), HashMap::from([
                ("Removable".into(), val(false)), ("ConnectionBus".into(), val("usb")),
            ]))])),
            (OwnedObjectPath::try_from(ID).unwrap(), HashMap::from([
                ("org.freedesktop.UDisks2.Block".into(), HashMap::from([
                    ("Device".into(), val(b"/dev/sdb1\0".to_vec())),
                    ("Drive".into(), val(OwnedObjectPath::try_from(DISK).unwrap())),
                    ("IdLabel".into(), val(r"USB Backup\x20")),
                    ("IdUsage".into(), val("filesystem")), ("HintIgnore".into(), val(false)),
                ])),
                ("org.freedesktop.UDisks2.Filesystem".into(), HashMap::from([
                    ("MountPoints".into(), val(if state == 1 { vec![b"/media/USB Backup\0".to_vec()] } else { vec![] })),
                ])),
            ])),
        ])
    }
}
struct Filesystem { state: Arc<AtomicUsize>, calls: Arc<AtomicUsize> }
#[zbus::interface(name = "org.freedesktop.UDisks2.Filesystem")]
impl Filesystem {
    fn mount(&self, _options: HashMap<String, OwnedValue>) -> zbus::fdo::Result<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.state.load(Ordering::SeqCst) {
            3 => Err(zbus::fdo::Error::AccessDenied("Not authorized to mount USB Backup".into())),
            4 => Ok("relative/path".into()),
            _ => { self.state.store(1, Ordering::SeqCst); Ok("/media/USB Backup".into()) }
        }
    }
}
struct Bus(Child);
impl Drop for Bus { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }
async fn bus() -> (Bus, zbus::Connection, zbus::Connection, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let mut child = Command::new("dbus-daemon").args(["--session", "--nofork", "--print-address=1"]).stdout(Stdio::piped()).spawn().unwrap();
    let mut address = String::new(); BufReader::new(child.stdout.take().unwrap()).read_line(&mut address).unwrap();
    let state = Arc::new(AtomicUsize::new(0)); let calls = Arc::new(AtomicUsize::new(0));
    let server = zbus::connection::Builder::address(address.trim()).unwrap().name("org.freedesktop.UDisks2").unwrap()
        .serve_at("/org/freedesktop/UDisks2", Manager { state: state.clone() }).unwrap()
        .serve_at(ID, Filesystem { state: state.clone(), calls: calls.clone() }).unwrap().build().await.unwrap();
    let client = zbus::connection::Builder::address(address.trim()).unwrap().build().await.unwrap();
    (Bus(child), server, client, state, calls)
}
#[tokio::test]
async fn native_discovery_mount_refresh_and_removal_use_the_desktop_service() {
    let (_bus, _server, client, state, calls) = bus().await;
    let sys = tempfile::tempdir().unwrap(); let labels = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(sys.path().join("sdb/sdb1")).unwrap();
    std::fs::write(sys.path().join("sdb/removable"), "0").unwrap();
    let discover = |mounts| enumerate_with_connection(mounts, sys.path(), labels.path(), Some(&client));
    let before = discover("").await;
    assert_eq!(before.len(), 1, "unmounted USB HDD must appear before Thunar opens it");
    assert_eq!(before[0].name, r"USB Backup\x20", "UDisks labels are already decoded");
    assert_eq!(before[0].path, "");
    assert_eq!(before[0].device_id.as_deref(), Some(ID));
    assert_eq!(serde_json::to_value(&before[0].kind).unwrap(), "removable");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "discovery must never mount");
    assert_eq!(mount_with_connection(&client, ID).await.unwrap(), "/media/USB Backup");
    let mounted = discover("42 35 8:17 / /media/USB\\040Backup rw - ext4 /dev/sdb1 rw\n").await;
    assert_eq!(mounted.len(), 1, "mount table and UDisks must merge to one volume");
    assert_eq!(mounted[0].device_id, before[0].device_id);
    assert_eq!(mounted[0].path, "/media/USB Backup");
    assert_eq!(mount_with_connection(&client, ID).await.unwrap(), "/media/USB Backup");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "already mounted volumes open directly");
    state.store(2, Ordering::SeqCst);
    assert!(discover("").await.is_empty());
    assert!(mount_with_connection(&client, ID).await.is_err(), "removed object must not mount");
    state.store(0, Ordering::SeqCst);
    assert_eq!(discover("").await.len(), 1, "insertion appears on the next refresh");
}
#[tokio::test]
async fn native_mount_errors_and_invalid_paths_do_not_become_navigation_targets() {
    let (_bus, _server, client, state, _) = bus().await;
    state.store(3, Ordering::SeqCst);
    assert!(mount_with_connection(&client, ID).await.unwrap_err().to_string().contains("Not authorized"));
    state.store(4, Ordering::SeqCst);
    assert!(mount_with_connection(&client, ID).await.is_err());
    assert!(mount_with_connection(&client, "/unrelated/object").await.is_err());
}
#[tokio::test]
async fn fallback_decodes_udev_aliases_once_without_changing_navigation_paths() {
    let sys = tempfile::tempdir().unwrap(); let labels = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(sys.path().join("sdb/sdb1")).unwrap();
    std::fs::write(sys.path().join("sdb/removable"), "1").unwrap();
    std::os::unix::fs::symlink("/dev/sdb1", labels.path().join(r"USB\x20Backup\x5cx20")).unwrap();
    let mounts = "42 35 8:17 / /media/USB\\040Backup rw - ext4 /dev/sdb1 rw\n";
    let drives = enumerate_with_connection(mounts, sys.path(), labels.path(), None).await;
    assert_eq!(drives.len(), 1);
    assert_eq!(drives[0].name, r"USB Backup\x20");
    assert_eq!(drives[0].path, "/media/USB Backup");
}
