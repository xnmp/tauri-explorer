//! The Linux runtime owns its profile before recovery and until backend shutdown.
use crate::error::AppError;
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs::{File, OpenOptions},
    path::Path,
};

pub(super) fn acquire(profile: &Path) -> Result<File, AppError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(profile.join(".plugin-runtime.lock"))?;
    if !file.metadata()?.is_file() {
        return Err(AppError::Other(
            "Plugin runtime lease must be a regular file".into(),
        ));
    }
    file.try_lock().map_err(|cause| {
        AppError::Other(format!(
            "Another Tauri Explorer process owns this plugin profile: {cause}"
        ))
    })?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_another_owner_and_releases_without_unlinking_the_lock() {
        let profile = tempfile::tempdir().unwrap();
        let first = acquire(profile.path()).unwrap();
        assert!(acquire(profile.path()).is_err());
        drop(first);
        assert!(profile.path().join(".plugin-runtime.lock").exists());
        acquire(profile.path()).unwrap();
    }
    #[test]
    fn independent_profiles_can_have_independent_owners() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let _first = acquire(first.path()).unwrap();
        let _second = acquire(second.path()).unwrap();
    }
    #[test]
    fn rejects_a_planted_lease_symlink() {
        let profile = tempfile::tempdir().unwrap();
        let target = profile.path().join("target");
        std::fs::write(&target, b"untouched").unwrap();
        std::os::unix::fs::symlink(&target, profile.path().join(".plugin-runtime.lock")).unwrap();
        assert!(acquire(profile.path()).is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"untouched");
    }
    #[test]
    fn another_process_cannot_acquire_the_profile_until_its_owner_exits() {
        let profile = tempfile::tempdir().unwrap();
        let owner = acquire(profile.path()).unwrap();
        let run = |expected: &str| {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "installed_plugins::ownership::tests::child_checks_profile_lease",
                ])
                .env("TE_LEASE_TEST_PROFILE", profile.path())
                .env("TE_LEASE_EXPECT", expected)
                .output()
                .unwrap()
        };
        let blocked = run("busy");
        assert!(
            blocked.status.success(),
            "{}",
            String::from_utf8_lossy(&blocked.stderr)
        );
        drop(owner);
        let acquired = run("free");
        assert!(
            acquired.status.success(),
            "{}",
            String::from_utf8_lossy(&acquired.stderr)
        );
    }
    #[test]
    #[ignore]
    fn child_checks_profile_lease() {
        let profile = std::env::var_os("TE_LEASE_TEST_PROFILE").expect("Owned test child only");
        let expected = std::env::var("TE_LEASE_EXPECT").unwrap();
        assert_eq!(acquire(Path::new(&profile)).is_ok(), expected == "free");
    }
}
