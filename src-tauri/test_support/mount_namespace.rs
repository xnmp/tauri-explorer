//! Real mounts for ignored mount-boundary tests. They run only inside a private
//! user/mount namespace (see `e2e-tauri/README.md`), never in the caller's.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// Panics unless this process runs in a namespace other than the one that
/// launched the documented `unshare` command.
pub(crate) fn require_private_namespace() {
    let parent = std::env::var_os("EXPLORER_MOUNT_TEST_PARENT_NS")
        .expect("run through the documented isolated mount namespace command");
    assert_ne!(
        fs::read_link("/proc/self/ns/mnt").unwrap().as_os_str(),
        parent,
        "refusing to mount in the caller's namespace"
    );
}

/// A bind mount that is detached when dropped, so a failing assertion cannot
/// strand it over a temporary directory.
pub(crate) struct BindMount(PathBuf);

impl BindMount {
    /// Bind `source` over `target`. Both live on one filesystem, so the mount
    /// point keeps its device number: only a mount-identity check can see it.
    pub(crate) fn new(source: &Path, target: &Path) -> Self {
        run(
            "mount",
            &["--bind".as_ref(), source.as_os_str(), target.as_os_str()],
        );
        Self(target.to_owned())
    }
}

impl Drop for BindMount {
    fn drop(&mut self) {
        let _ = Command::new("umount").arg(&self.0).status();
    }
}

fn run(program: &str, args: &[&std::ffi::OsStr]) {
    assert!(
        Command::new(program).args(args).status().unwrap().success(),
        "{program} {args:?}"
    );
}
