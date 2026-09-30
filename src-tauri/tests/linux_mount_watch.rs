#![cfg(target_os = "linux")]
//! Real kernel mount-table notifications (#888). Mounting needs a private
//! user and mount namespace, so this is opt-in:
//!
//! ```sh
//! EXPLORER_MOUNT_TEST_PARENT_NS=$(readlink /proc/self/ns/mnt) \
//!   unshare --user --map-root-user --mount \
//!   cargo test --test linux_mount_watch -- --ignored
//! ```
use std::{path::Path, process::Command, time::Duration};
use tauri_explorer_lib::files::linux_mount_watch::{host_mount_table_drives, MountTableWatch};
use tokio::sync::mpsc;

/// Refuse to mount anywhere but a namespace other than the launching one.
fn require_private_namespace() {
    let parent = std::env::var_os("EXPLORER_MOUNT_TEST_PARENT_NS")
        .expect("run through the documented unshare command");
    assert_ne!(
        std::fs::read_link("/proc/self/ns/mnt").unwrap().as_os_str(),
        parent,
        "refusing to mount in the caller's namespace"
    );
}

/// Detached on drop, so a failing assertion cannot strand the mount.
struct Mounted(std::path::PathBuf);
impl Mounted {
    fn new(args: &[&str], target: &Path) -> Self {
        let status = Command::new("mount")
            .args(args)
            .arg(target)
            .status()
            .unwrap();
        assert!(status.success(), "mount {args:?} {target:?}");
        Self(target.to_owned())
    }
}
impl Drop for Mounted {
    fn drop(&mut self) {
        let _ = Command::new("umount").arg(&self.0).status();
    }
}

async fn pushed(pushes: &mut mpsc::UnboundedReceiver<()>, within: Duration) -> bool {
    tokio::time::timeout(within, pushes.recv()).await.is_ok()
}

#[tokio::test]
#[ignore = "requires unshare --user --map-root-user --mount (see module docs)"]
async fn drive_mounts_are_pushed_promptly_and_irrelevant_mounts_are_silent() {
    require_private_namespace();
    let (notify, mut pushes) = mpsc::unbounded_channel();
    let _watch = MountTableWatch::spawn(
        Path::new("/proc/self/mountinfo"),
        host_mount_table_drives,
        move || {
            let _ = notify.send(());
        },
    )
    .unwrap();
    // A block-backed directory, so a bind mount of it is a sidebar drive.
    let base = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    for dir in ["scratch", "source", "Bound Drive"] {
        std::fs::create_dir(base.path().join(dir)).unwrap();
    }

    let scratch = Mounted::new(&["-t", "tmpfs", "tmpfs"], &base.path().join("scratch"));
    assert!(
        !pushed(&mut pushes, Duration::from_millis(500)).await,
        "tmpfs is not a drive"
    );

    let target = base.path().join("Bound Drive");
    let source = base.path().join("source");
    let bound = Mounted::new(&["--bind", source.to_str().unwrap()], &target);
    assert!(
        host_mount_table_drives(&std::fs::read_to_string("/proc/self/mountinfo").unwrap())
            .iter()
            .any(|d| d.path.as_deref() == target.to_str()),
        "fixture precondition: the bind mount is a drive"
    );
    assert!(
        pushed(&mut pushes, Duration::from_secs(2)).await,
        "mount pushed well before the 30 s backstop"
    );
    drop(bound);
    assert!(
        pushed(&mut pushes, Duration::from_secs(2)).await,
        "unmount pushed"
    );
    drop(scratch);
    assert!(
        !pushed(&mut pushes, Duration::from_millis(500)).await,
        "tmpfs removal is silent"
    );
}
