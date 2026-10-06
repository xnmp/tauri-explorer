//! Startup requests use the same transactional installer as the UI.
use crate::error::AppError;
use std::{fs, path::Path, time::SystemTime};

pub(super) fn apply(
    directory: &Path,
    mut install: impl FnMut(&Path) -> Result<(), AppError>,
    cancelled: impl Fn() -> bool,
) -> Result<Vec<String>, AppError> {
    match fs::symlink_metadata(directory) {
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(cause) => return Err(cause.into()),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(AppError::Other(
                "Plugin queue must be a directory, not a symlink".into(),
            ))
        }
        Ok(_) => {}
    }
    let entries = fs::read_dir(directory)?
        .take(257)
        .collect::<Result<Vec<_>, _>>()?;
    if entries.len() > 256 {
        return Err(AppError::Other(
            "Plugin queue exceeds its entry limit".into(),
        ));
    }
    let mut packages = entries
        .into_iter()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("teplugin"))
        })
        .collect::<Vec<_>>();
    if packages.len() > 64 {
        return Err(AppError::Other("Too many queued plugin packages".into()));
    }
    // Earlier requests precede newer ones; an explicit later downgrade is respected.
    packages.sort_by_key(|entry| {
        (
            entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH),
            entry.file_name(),
        )
    });
    let mut errors = vec![];
    for entry in packages {
        if cancelled() {
            break;
        }
        let result = if !entry.file_type()?.is_file() {
            Err(AppError::Other(
                "Queued plugin must be a regular file".into(),
            ))
        } else {
            install(&entry.path())
        };
        match result {
            Ok(()) => {
                fs::remove_file(entry.path())?;
            }
            Err(cause) => {
                if cancelled() {
                    break;
                }
                let failed = directory.join("failed");
                fs::create_dir_all(&failed)?;
                let metadata = fs::symlink_metadata(&failed)?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(AppError::Other(
                        "Failed plugin requests must use a real directory".into(),
                    ));
                }
                // A failed older request must never retry over a newer success.
                fs::rename(entry.path(), failed.join(entry.file_name()))?;
                errors.push(format!("Queued plugin could not be installed: {cause}"));
            }
        }
    }
    Ok(errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_queue_is_optional() {
        let temp = tempfile::tempdir().unwrap();
        assert!(apply(
            &temp.path().join("absent"),
            |_| panic!("No install expected"),
            || false
        )
        .unwrap()
        .is_empty());
    }
    #[test]
    fn applies_complete_packages_once_and_quarantines_failed_requests() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("good.teplugin"), b"complete bytes").unwrap();
        fs::write(root.join("bad.teplugin"), b"invalid bytes").unwrap();
        fs::write(root.join(".stage-partial"), b"partial").unwrap();
        let mut installed = vec![];
        let errors = apply(
            root,
            |path| {
                let bytes = fs::read(path)?;
                if bytes == b"invalid bytes" {
                    return Err(AppError::Other("Invalid archive".into()));
                }
                installed.push(bytes);
                Ok(())
            },
            || false,
        )
        .unwrap();
        assert_eq!(installed, vec![b"complete bytes".to_vec()]);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("Invalid archive"));
        assert!(!root.join("good.teplugin").exists());
        assert!(!root.join("bad.teplugin").exists());
        assert!(root.join("failed/bad.teplugin").exists());
        assert!(root.join(".stage-partial").exists());
        assert!(apply(
            root,
            |_| panic!("Committed packages must not replay"),
            || false
        )
        .unwrap()
        .is_empty());
    }
    #[test]
    fn a_failed_older_request_never_replays_after_a_newer_success() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("v1.teplugin"), b"v1").unwrap();
        fs::write(root.join("v2.teplugin"), b"v2").unwrap();
        let mut current = String::new();
        apply(
            root,
            |path| {
                let version = fs::read_to_string(path)?;
                if version == "v1" {
                    return Err(AppError::Other("Transient failure".into()));
                }
                current = version;
                Ok(())
            },
            || false,
        )
        .unwrap();
        assert_eq!(current, "v2");
        apply(
            root,
            |_| panic!("A stale failed request must not downgrade v2"),
            || false,
        )
        .unwrap();
        assert!(root.join("failed/v1.teplugin").exists());
    }
    #[test]
    fn shutdown_retains_interrupted_and_unstarted_requests_for_next_launch() {
        use std::cell::Cell;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("first.teplugin"), b"first").unwrap();
        fs::write(root.join("second.teplugin"), b"second").unwrap();
        let closing = Cell::new(false);
        apply(
            root,
            |_| {
                closing.set(true);
                Err(AppError::Other("Host shutting down".into()))
            },
            || closing.get(),
        )
        .unwrap();
        assert_eq!(fs::read(root.join("first.teplugin")).unwrap(), b"first");
        assert_eq!(fs::read(root.join("second.teplugin")).unwrap(), b"second");
        assert!(!root.join("failed").exists());
    }
    #[test]
    fn rejects_an_excessive_queue_without_installing_or_removing_anything() {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..65 {
            fs::write(temp.path().join(format!("{index}.teplugin")), b"fixture").unwrap();
        }
        assert!(apply(temp.path(), |_| panic!("No install expected"), || false).is_err());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 65);
    }
    #[test]
    fn preserves_a_new_request_published_while_installing_an_older_one() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("old.teplugin"), b"old").unwrap();
        apply(
            root,
            |_| {
                fs::write(root.join("new.teplugin"), b"new")?;
                Ok(())
            },
            || false,
        )
        .unwrap();
        assert!(!root.join("old.teplugin").exists());
        assert_eq!(fs::read(root.join("new.teplugin")).unwrap(), b"new");
    }
    #[test]
    fn installs_requests_in_publication_order_even_when_filenames_sort_differently() {
        use std::time::Duration;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for (name, seconds) in [("z-first.teplugin", 1), ("a-latest.TEPLUGIN", 2)] {
            let file = fs::File::create(root.join(name)).unwrap();
            file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
                .unwrap();
        }
        let mut order = vec![];
        apply(
            root,
            |path| {
                order.push(path.file_name().unwrap().to_owned());
                Ok(())
            },
            || false,
        )
        .unwrap();
        assert_eq!(order, ["z-first.teplugin", "a-latest.TEPLUGIN"]);
    }
    #[cfg(unix)]
    #[test]
    fn never_follows_a_queue_or_package_symlink() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir(root.join("queue")).unwrap();
        fs::write(root.join("outside"), b"outside").unwrap();
        symlink(root.join("outside"), root.join("queue/link.teplugin")).unwrap();
        assert_eq!(
            apply(
                &root.join("queue"),
                |_| panic!("Symlink must not install"),
                || false
            )
            .unwrap()
            .len(),
            1
        );
        assert_eq!(fs::read(root.join("outside")).unwrap(), b"outside");
        symlink(root.join("queue"), root.join("linked-queue")).unwrap();
        assert!(apply(
            &root.join("linked-queue"),
            |_| panic!("No install expected"),
            || false
        )
        .is_err());
    }
}
