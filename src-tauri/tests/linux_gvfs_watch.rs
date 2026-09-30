#![cfg(target_os = "linux")]
//! GVfs mount announcements on an isolated session bus, with a temporary
//! directory standing in for `$XDG_RUNTIME_DIR/gvfs` (#888).
use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};
use tauri_explorer_lib::{error::AppError, files::linux_gvfs_watch::GvfsWatch};
use tokio::sync::mpsc;

struct Daemon(Child);
impl Drop for Daemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn daemon() -> (Daemon, String) {
    let mut child = Command::new("dbus-daemon")
        .args(["--session", "--nofork", "--print-address=1"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut address = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut address)
        .unwrap();
    (Daemon(child), address.trim().to_owned())
}

async fn connect(address: &str) -> Result<zbus::Connection, AppError> {
    zbus::connection::Builder::address(address)
        .map_err(|e| AppError::Other(e.to_string()))?
        .build()
        .await
        .map_err(|e| AppError::Other(e.to_string()))
}

/// A stand-in for gvfsd's mount tracker announcing a change.
async fn announce(tracker: &zbus::Connection, member: &str) {
    tracker
        .emit_signal(
            None::<&str>,
            "/org/gtk/vfs/mounttracker",
            "org.gtk.vfs.MountTracker",
            member,
            &("mount",),
        )
        .await
        .unwrap();
}

async fn pushed(pushes: &mut mpsc::UnboundedReceiver<()>, within: Duration) -> bool {
    tokio::time::timeout(within, pushes.recv()).await.is_ok()
}

#[tokio::test]
async fn gvfs_drive_mounts_are_pushed_and_other_backends_are_silent() {
    let (_daemon, address) = daemon();
    let tracker = zbus::connection::Builder::address(address.as_str())
        .unwrap()
        .name("org.gtk.vfs.Daemon")
        .unwrap()
        .build()
        .await
        .unwrap();
    let gvfs = tempfile::tempdir().unwrap();
    let (notify, mut pushes) = mpsc::unbounded_channel();
    let _watch = GvfsWatch::start(connect(&address), gvfs.path().to_owned(), move || {
        let _ = notify.send(());
    })
    .await
    .unwrap();
    let google = gvfs.path().join("google-drive:host=user@example.com");

    std::fs::create_dir(&google).unwrap();
    announce(&tracker, "Mounted").await;
    assert!(
        pushed(&mut pushes, Duration::from_secs(2)).await,
        "Google Drive mount is pushed"
    );

    std::fs::create_dir(gvfs.path().join("archive:host=a.zip")).unwrap();
    announce(&tracker, "Mounted").await;
    assert!(
        !pushed(&mut pushes, Duration::from_millis(500)).await,
        "a non-drive GVfs mount is silent"
    );

    std::fs::remove_dir(&google).unwrap();
    announce(&tracker, "Unmounted").await;
    assert!(
        pushed(&mut pushes, Duration::from_secs(2)).await,
        "unmount is pushed"
    );
}

#[tokio::test]
async fn directory_changes_without_an_announcement_are_left_to_the_backstop() {
    // gvfsd-fuse raises no inotify events for its entries, so the tracker's
    // signal is the only trigger: an unannounced change is not pushed.
    let (_daemon, address) = daemon();
    let gvfs = tempfile::tempdir().unwrap();
    let (notify, mut pushes) = mpsc::unbounded_channel();
    let _watch = GvfsWatch::start(connect(&address), gvfs.path().to_owned(), move || {
        let _ = notify.send(());
    })
    .await
    .unwrap();
    std::fs::create_dir(gvfs.path().join("google-drive:host=user@example.com")).unwrap();
    assert!(!pushed(&mut pushes, Duration::from_millis(500)).await);
}

#[tokio::test]
async fn without_a_session_bus_no_watch_starts() {
    let result = GvfsWatch::start(
        async { Err(AppError::Other("no session bus".into())) },
        Path::new("/nonexistent").to_owned(),
        || {},
    )
    .await;
    assert!(result.is_err());
}
