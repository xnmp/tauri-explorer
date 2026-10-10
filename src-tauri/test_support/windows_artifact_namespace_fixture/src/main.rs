#[cfg(windows)]
#[path = "../../../src/windows_artifact_namespace.rs"]
mod windows_artifact_namespace;
fn main() {
    eprintln!("Run this exact-module fixture with cargo test on native Windows NTFS.");
}

#[cfg(all(test, windows))]
mod native_tests {
    use super::windows_artifact_namespace::AnchoredDirectory;
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
    use std::{
        ffi::OsStr,
        fs,
        io::{Read, Seek, SeekFrom, Write},
        path::PathBuf,
        process::Command,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    fn writable_directory_flush(root: &AnchoredDirectory) -> windows::core::Result<()> {
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::{GENERIC_READ, GENERIC_WRITE},
                Storage::FileSystem::*,
            },
        };
        // Probe a fresh private child after its read guard closes. Asking to
        // upgrade the held ancestor would only measure our sharing restriction.
        let probe = root
            .create_directory(OsStr::new("directory-flush-probe"))
            .expect("write-through probe directory");
        let mut path: Vec<_> = probe.path().as_os_str().encode_wide().collect();
        path.push(0);
        drop(probe);
        let handle = unsafe {
            CreateFileW(
                PCWSTR(path.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_READ,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
                None,
            )
        }?;
        let file = unsafe { std::fs::File::from_raw_handle(handle.0) };
        assert!(file.metadata().unwrap().is_dir());
        unsafe { FlushFileBuffers(handle) }
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        directory: Option<AnchoredDirectory>,
        path: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let parent = AnchoredDirectory::open_absolute(&std::env::temp_dir()).expect(
                "native fixture requires a local NTFS temp directory without reparse ancestors",
            );
            let name = format!(
                "te-namespace-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            let directory = parent
                .create_directory(OsStr::new(&name))
                .expect("native write-through directory creation");
            Self {
                path: directory.path().to_owned(),
                directory: Some(directory),
            }
        }
        fn root(&self) -> &AnchoredDirectory {
            self.directory.as_ref().unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            drop(self.directory.take());
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn native_write_through_namespace_and_real_flush_results() {
        let root = Fixture::new();
        let mut pending = root.root().create_new(OsStr::new("pending")).unwrap();
        pending
            .file_mut()
            .write_all(b"exact fixture bytes")
            .unwrap();
        pending.flush().unwrap();
        let mut published = root
            .root()
            .publish_noreplace(pending, OsStr::new("final"))
            .unwrap();
        root.root().flush_evidence(&published).unwrap();
        published.file_mut().seek(SeekFrom::Start(0)).unwrap();
        let mut bytes = vec![];
        published.file_mut().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"exact fixture bytes");
        assert!(published.file().metadata().unwrap().is_file());
        println!("QUALIFICATION directory_flush={:?}; file_flush=success; NTFS_native_write_through_create_and_rename=success; readonly_anchor_flush={:?}", writable_directory_flush(root.root()), root.root().probe_directory_flush());
        drop(published);
        let readonly = root
            .root()
            .open_regular(OsStr::new("final"), false)
            .unwrap();
        assert_eq!(
            readonly.flush().unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
    }
    #[test]
    fn native_invalid_stream_traversal_device_and_oversized_names_create_nothing() {
        let root = Fixture::new();
        for name in [
            "..",
            ".",
            "a:b",
            "a\\b",
            "a/b",
            "CON",
            "nul.png",
            "LPT1.png",
            "trailing.",
            "trailing ",
            "a\0b",
        ] {
            assert!(
                root.root().create_new(OsStr::new(name)).is_err(),
                "{name:?}"
            );
        }
        assert!(root
            .root()
            .create_new(OsStr::new(&"x".repeat(1_000_000)))
            .is_err());
        assert!(AnchoredDirectory::open_absolute(std::path::Path::new("C:relative")).is_err());
        assert!(
            AnchoredDirectory::open_absolute(std::path::Path::new("\\\\server\\share")).is_err()
        );
        assert_eq!(fs::read_dir(&root.path).unwrap().count(), 0);
    }
    #[test]
    fn native_publication_never_clobbers_an_existing_immutable_name() {
        let root = Fixture::new();
        {
            let mut existing = root.root().create_new(OsStr::new("final")).unwrap();
            existing.file_mut().write_all(b"original").unwrap();
            existing.flush().unwrap();
        }
        let mut pending = root.root().create_new(OsStr::new("pending")).unwrap();
        pending
            .file_mut()
            .write_all(b"replacement refused")
            .unwrap();
        assert!(root
            .root()
            .publish_noreplace(pending, OsStr::new("final"))
            .is_err());
        assert_eq!(fs::read(root.path.join("final")).unwrap(), b"original");
        assert_eq!(
            fs::read(root.path.join("pending")).unwrap(),
            b"replacement refused"
        );
        let mut small = root.root().create_new(OsStr::new("small-pending")).unwrap();
        small.file_mut().write_all(b"single UTF16 name").unwrap();
        let small = root
            .root()
            .publish_noreplace(small, OsStr::new("x"))
            .unwrap();
        assert_eq!(fs::read(small.path()).unwrap(), b"single UTF16 name");
    }
    #[test]
    fn native_child_io_retains_ancestor_rename_guards_after_directory_owner_drops() {
        let mut root = Fixture::new();
        let directory = root.directory.take().unwrap();
        let mut child = directory.create_new(OsStr::new("held")).unwrap();
        child.file_mut().write_all(b"held bytes").unwrap();
        drop(directory);
        let moved = root.path.with_extension("moved");
        assert!(fs::rename(&root.path, &moved).is_err());
        child.flush().unwrap();
        drop(child);
        fs::rename(&root.path, &moved).unwrap();
        root.path = moved;
    }
    #[test]
    fn native_junction_ancestors_and_final_reparse_nodes_are_refused() {
        let root = Fixture::new();
        let target = Fixture::new();
        let junction = root.path.join("junction");
        let result = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&target.path)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "fixture junction creation failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(AnchoredDirectory::open_absolute(&junction).is_err());
        assert!(root
            .root()
            .open_regular(OsStr::new("junction"), false)
            .is_err());
        assert_eq!(fs::read_dir(&target.path).unwrap().count(), 0);
        fs::remove_dir(junction).unwrap();
    }
    #[test]
    fn native_cross_namespace_publication_and_acquisition_are_refused() {
        let root = Fixture::new();
        let other = Fixture::new();
        let mut pending = root.root().create_new(OsStr::new("pending")).unwrap();
        pending.file_mut().write_all(b"owned").unwrap();
        assert!(other.root().flush_evidence(&pending).is_err());
        assert!(other
            .root()
            .publish_noreplace(pending, OsStr::new("final"))
            .is_err());
        assert_eq!(fs::read(root.path.join("pending")).unwrap(), b"owned");
        assert!(!other.path.join("final").exists());
    }
    #[test]
    fn native_long_unicode_paths_still_use_anchored_regular_handles() {
        let root = Fixture::new();
        let mut directory = AnchoredDirectory::open_absolute(&root.path).unwrap();
        for index in 0..18 {
            directory = directory
                .create_directory(OsStr::new(&format!("{index:02}-unicode-名前")))
                .unwrap();
        }
        assert!(directory.path().as_os_str().len() > 260);
        let mut pending = directory.create_new(OsStr::new("input.pending")).unwrap();
        pending.file_mut().write_all(b"unicode-long-path").unwrap();
        let published = directory
            .publish_noreplace(pending, OsStr::new("input.png"))
            .unwrap();
        let path = published.path().to_owned();
        drop(published);
        drop(directory);
        let parent = AnchoredDirectory::open_absolute(path.parent().unwrap()).unwrap();
        let mut reopened = parent
            .open_regular(path.file_name().unwrap(), true)
            .unwrap();
        reopened.flush().unwrap();
        let mut bytes = vec![];
        reopened.file_mut().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"unicode-long-path");
    }
    #[test]
    fn native_process_crash_after_pending_rename_and_final_flush_retains_original_bytes() {
        for stage in ["after-pending", "after-rename", "after-final-flush"] {
            let root = Fixture::new();
            let child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "native_tests::native_child_crash_boundary",
                    "--nocapture",
                ])
                .env("TE_NAMESPACE_FIXTURE_ROOT", &root.path)
                .env("TE_NAMESPACE_FIXTURE_STAGE", stage)
                .output()
                .unwrap();
            assert_eq!(
                child.status.code(),
                Some(91),
                "{stage}: {}",
                String::from_utf8_lossy(&child.stderr)
            );
            let filename = if stage == "after-pending" {
                "crash-pending"
            } else {
                "crash-final"
            };
            let mut reopened = root
                .root()
                .open_regular(OsStr::new(filename), true)
                .unwrap();
            let mut bytes = vec![];
            reopened.file_mut().read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"original-paid-output-fixture");
            reopened.flush().unwrap();
            assert!(!root
                .path
                .join(if filename == "crash-pending" {
                    "crash-final"
                } else {
                    "crash-pending"
                })
                .exists());
        }
    }
    #[test]
    #[ignore = "private child process helper, exercised by crash outcome test"]
    fn native_child_crash_boundary() {
        let root = AnchoredDirectory::open_absolute(&PathBuf::from(
            std::env::var_os("TE_NAMESPACE_FIXTURE_ROOT").unwrap(),
        ))
        .unwrap();
        let mut pending = root.create_new(OsStr::new("crash-pending")).unwrap();
        pending
            .file_mut()
            .write_all(b"original-paid-output-fixture")
            .unwrap();
        pending.flush().unwrap();
        if std::env::var("TE_NAMESPACE_FIXTURE_STAGE").unwrap() == "after-pending" {
            std::process::exit(91);
        }
        let published = root
            .publish_noreplace(pending, OsStr::new("crash-final"))
            .unwrap();
        published.flush().unwrap();
        std::process::exit(91);
    }
}
