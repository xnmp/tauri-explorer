//! GVfs change source for sidebar cloud drives (#888).
//!
//! GVfs exposes each user-visible mount (for example a Google Drive account)
//! as an entry in its FUSE directory, `$XDG_RUNTIME_DIR/gvfs`. Adding one
//! changes no mount table, UDisks never sees it, and gvfsd-fuse does not raise
//! inotify events for its own entries (verified: `gio mount` of an archive
//! produced none). GVfs announces mounts on the session bus instead: its
//! `org.gtk.vfs.MountTracker` emits `Mounted`/`Unmounted`, which GIO's own
//! volume monitors consume. One task subscribes to those signals, re-derives
//! the drives from the directory, and notifies only when they change. Without
//! a session bus or GVfs, no push arrives and the backstop poll still lists
//! GVfs drives.
use super::drives::{linux_gvfs_google_drives, Drive};
use super::linux_mount_watch::Derived;
use crate::error::AppError;
use std::{future::Future, path::PathBuf, pin::Pin, time::Duration};
use zbus::{export::futures_core::Stream, message::Type, Connection, MessageStream};

const TRACKER_SENDER: &str = "org.gtk.vfs.Daemon";
const TRACKER_PATH: &str = "/org/gtk/vfs/mounttracker";
const TRACKER_INTERFACE: &str = "org.gtk.vfs.MountTracker";
/// Let gvfsd-fuse publish the entry, and fold a burst into one re-read.
const SETTLE: Duration = Duration::from_millis(100);

/// A running watch; dropping it stops the task.
pub struct GvfsWatch(tokio::task::JoinHandle<()>);

impl Drop for GvfsWatch {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl GvfsWatch {
    /// Subscribe to GVfs mount announcements on the bus `connect` reaches,
    /// then keep deriving drives from `dir` on a task. Returns once subscribed,
    /// so no later mount can be missed; an error means no push source (no
    /// session bus), and the backstop poll still lists GVfs drives.
    pub async fn start<F, N>(connect: F, dir: PathBuf, notify: N) -> Result<Self, AppError>
    where
        F: Future<Output = Result<Connection, AppError>>,
        N: Fn() + Send + 'static,
    {
        let connection = connect.await?;
        let rule = zbus::MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(TRACKER_SENDER)
            .and_then(|rule| rule.path(TRACKER_PATH))
            .and_then(|rule| rule.interface(TRACKER_INTERFACE))
            .map(|rule| rule.build())
            .map_err(|e| AppError::Other(e.to_string()))?;
        // Subscribe before the first derivation so no mount falls between them.
        let mut signals = tokio::time::timeout(
            Duration::from_secs(2),
            MessageStream::for_match_rule(rule, &connection, None),
        )
        .await
        .map_err(|_| AppError::Other("GVfs subscription timed out".into()))?
        .map_err(|e| AppError::Other(e.to_string()))?;
        let mut state = Derived::new(derive(&dir).await);
        Ok(Self(tokio::spawn(async move {
            // The signal body is not needed: the directory is the source of
            // truth, and one re-read covers any mount or unmount.
            while let Some(Ok(_)) = next(&mut signals).await {
                tokio::time::sleep(SETTLE).await;
                if state.observe(derive(&dir).await) {
                    notify();
                }
            }
            log::warn!("GVfs mount watch stopped: session bus connection closed");
        })))
    }
}

/// Read the FUSE directory off the async workers: a wedged gvfsd-fuse must not
/// stall them.
async fn derive(dir: &std::path::Path) -> Vec<Drive> {
    let dir = dir.to_owned();
    tokio::task::spawn_blocking(move || linux_gvfs_google_drives(&dir))
        .await
        .unwrap_or_default()
}

async fn next(stream: &mut MessageStream) -> Option<zbus::Result<zbus::Message>> {
    std::future::poll_fn(|cx| Pin::new(&mut *stream).poll_next(cx)).await
}
