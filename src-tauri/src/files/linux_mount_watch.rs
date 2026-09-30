//! Mount-table change source for drives UDisks does not report (#888).
//!
//! Mount-table drives such as rclone FUSE mounts and bind or manual block
//! mounts never appear on UDisks2, so the subscription cannot announce them. The kernel signals every mount-table
//! change by marking `/proc/self/mountinfo` POLLPRI|POLLERR (proc(5)); systemd
//! and libmount's monitor rely on the same notification. One task waits for it
//! through Tokio's reactor, re-reads the table, and notifies only when the
//! drives derived from it change, so unrelated mounts (tmpfs, containers)
//! stay silent. If the file cannot be opened or registered, no watch starts and
//! the frontend's backstop poll remains the only mount-table source.
use super::drives::{linux_mount_table_drives, Drive};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    time::Duration,
};
use tokio::io::{unix::AsyncFd, Interest};

/// Mount storms (a desktop mounting several volumes) arrive as many wakes;
/// settle briefly so one re-read covers the burst.
const SETTLE: Duration = Duration::from_millis(50);

/// The production projection: drives the host's mount table yields.
#[doc(hidden)]
pub fn host_mount_table_drives(mountinfo: &str) -> Vec<Drive> {
    linux_mount_table_drives(
        mountinfo,
        Path::new("/sys/block"),
        Path::new("/dev/disk/by-label"),
    )
}

/// Change detection over successive derivations of a drive source: a push is
/// due only when what the sidebar would show differs from the last one.
pub struct Derived<T> {
    last: T,
}

impl<T: PartialEq> Derived<T> {
    pub fn new(initial: T) -> Self {
        Self { last: initial }
    }

    /// Record the next derivation; true when it differs from the last.
    pub fn observe(&mut self, next: T) -> bool {
        let changed = next != self.last;
        self.last = next;
        changed
    }
}

/// A running watch; dropping it stops the task and deregisters the file.
pub struct MountTableWatch(tokio::task::JoinHandle<()>);

impl Drop for MountTableWatch {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl MountTableWatch {
    /// Start watching `mountinfo`. Must run inside a Tokio runtime with I/O
    /// enabled. Errors mean the kernel notification is unavailable.
    pub fn spawn<T, P, N>(mountinfo: &Path, project: P, notify: N) -> io::Result<Self>
    where
        T: PartialEq + Send + 'static,
        P: Fn(&str) -> T + Send + 'static,
        N: Fn() + Send + 'static,
    {
        let fd = AsyncFd::with_interest(File::open(mountinfo)?, Interest::PRIORITY)?;
        let mut state = Derived::new(project(&read(fd.get_ref())?));
        Ok(Self(tokio::spawn(async move {
            loop {
                let mut guard = match fd.ready(Interest::PRIORITY).await {
                    Ok(guard) => guard,
                    Err(error) => {
                        log::warn!("Mount-table watch stopped: {error}");
                        return;
                    }
                };
                tokio::time::sleep(SETTLE).await;
                // Clear before reading: a change after this point raises a new
                // edge, so no change can fall between the read and the wait.
                guard.clear_ready();
                drop(guard);
                match read(fd.get_ref()) {
                    Ok(table) if state.observe(project(&table)) => notify(),
                    Ok(_) => {}
                    Err(error) => log::warn!("Cannot re-read the mount table: {error}"),
                }
            }
        })))
    }
}

fn read(mut file: &File) -> io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut table = String::new();
    file.read_to_string(&mut table)?;
    Ok(table)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "22 1 259:6 / / rw,relatime - ext4 /dev/nvme0n1p6 rw\n";
    const TMPFS: &str = "40 22 0:59 / /run/user/1000/scratch rw - tmpfs tmpfs rw\n";
    const USB: &str = "42 22 8:17 / /mnt/USB\\040Stick rw - vfat /dev/sdb1 rw\n";
    const RCLONE: &str = "43 22 0:60 / /home/u/Remote rw - fuse.rclone backup: rw\n";

    /// The production derivation over fixture sysfs, fed one table at a time.
    struct State<'a> {
        sys_block: &'a Path,
        derived: Derived<Vec<Drive>>,
    }
    impl State<'_> {
        fn observe(&mut self, table: &str) -> bool {
            let labels = self.sys_block.join("no-labels");
            self.derived
                .observe(linux_mount_table_drives(table, self.sys_block, &labels))
        }
    }
    fn state<'a>(sys_block: &'a Path, table: &str) -> State<'a> {
        let labels = sys_block.join("no-labels");
        State {
            sys_block,
            derived: Derived::new(linux_mount_table_drives(table, sys_block, &labels)),
        }
    }

    fn sys_block_with_usb() -> tempfile::TempDir {
        let sys_block = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(sys_block.path().join("sdb/sdb1")).unwrap();
        std::fs::write(sys_block.path().join("sdb/removable"), "1").unwrap();
        sys_block
    }

    #[test]
    fn an_unchanged_or_drive_irrelevant_table_is_silent() {
        let sys_block = sys_block_with_usb();
        let mut state = state(sys_block.path(), ROOT);
        assert!(!state.observe(ROOT), "same table");
        assert!(
            !state.observe(&format!("{ROOT}{TMPFS}")),
            "tmpfs is no drive"
        );
        assert!(!state.observe(ROOT), "nor is its removal");
    }

    #[test]
    fn drive_mounts_and_unmounts_are_changes() {
        let sys_block = sys_block_with_usb();
        let mut state = state(sys_block.path(), ROOT);
        assert!(state.observe(&format!("{ROOT}{USB}")), "block mount");
        assert!(!state.observe(&format!("{ROOT}{USB}")));
        assert!(state.observe(&format!("{ROOT}{USB}{RCLONE}")), "FUSE mount");
        assert!(state.observe(&format!("{ROOT}{RCLONE}")), "unmount");
        assert!(
            state.observe(""),
            "an unreadable-then-empty table drops all"
        );
    }

    #[tokio::test]
    async fn a_missing_mount_table_degrades_to_no_watch() {
        let missing = tempfile::tempdir().unwrap().path().join("mountinfo");
        assert!(MountTableWatch::spawn(&missing, host_mount_table_drives, || {}).is_err());
    }

    #[tokio::test]
    async fn a_file_without_poll_notifications_degrades_to_no_watch() {
        // Regular files cannot join epoll, so this path reports an error
        // instead of spinning or silently never waking.
        let plain = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(plain.path(), ROOT).unwrap();
        assert!(MountTableWatch::spawn(plain.path(), host_mount_table_drives, || {}).is_err());
    }
}
