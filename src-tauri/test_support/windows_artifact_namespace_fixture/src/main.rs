#[cfg(windows)]
#[path = "../../../src/windows_artifact_namespace.rs"]
mod windows_artifact_namespace;
fn main() {
    eprintln!("Run this exact-module fixture with cargo test on native Windows NTFS.");
}

#[cfg(all(test, windows))]
mod native_tests {
    use super::windows_artifact_namespace::{AnchoredDirectory, DeletionOutcome};
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
    #[derive(Debug)]
    struct AceEvidence {
        kind: u8,
        flags: u8,
        mask: u32,
        sid: String,
    }
    #[derive(Debug)]
    struct SecurityEvidence {
        owner: String,
        protected: bool,
        entries: Vec<AceEvidence>,
    }
    struct LocalAllocation(*mut std::ffi::c_void);
    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    windows::Win32::Foundation::LocalFree(Some(
                        windows::Win32::Foundation::HLOCAL(self.0),
                    ));
                }
            }
        }
    }
    fn sid_text(sid: windows::Win32::Security::PSID) -> String {
        let mut text = windows::core::PWSTR::null();
        unsafe { windows::Win32::Security::Authorization::ConvertSidToStringSidW(sid, &mut text) }
            .unwrap();
        let _allocation = LocalAllocation(text.0.cast());
        unsafe { text.to_string() }.unwrap()
    }
    fn security_handle(path: &std::path::Path, directory: bool, writable: bool) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem as win;
        fs::OpenOptions::new()
            .access_mode(win::READ_CONTROL.0 | if writable { win::WRITE_DAC.0 } else { 0 })
            .share_mode((win::FILE_SHARE_READ | win::FILE_SHARE_WRITE | win::FILE_SHARE_DELETE).0)
            .custom_flags(
                win::FILE_FLAG_OPEN_REPARSE_POINT.0
                    | if directory {
                        win::FILE_FLAG_BACKUP_SEMANTICS.0
                    } else {
                        0
                    },
            )
            .open(path)
            .unwrap()
    }
    fn security_evidence(path: &std::path::Path, directory: bool) -> SecurityEvidence {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Security::{self as sec, Authorization as acl},
        };
        let file = security_handle(path, directory, false);
        let mut descriptor = sec::PSECURITY_DESCRIPTOR::default();
        unsafe {
            acl::GetSecurityInfo(
                HANDLE(file.as_raw_handle()),
                acl::SE_FILE_OBJECT,
                sec::OWNER_SECURITY_INFORMATION | sec::DACL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                Some(&mut descriptor),
            )
        }
        .ok()
        .unwrap();
        let _allocation = LocalAllocation(descriptor.0);
        let mut owner = sec::PSID::default();
        let mut defaulted = windows::core::BOOL::default();
        unsafe { sec::GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted) }.unwrap();
        let mut present = windows::core::BOOL::default();
        let mut dacl = std::ptr::null_mut();
        unsafe {
            sec::GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
        }
        .unwrap();
        assert!(
            present.as_bool() && !dacl.is_null(),
            "null/absent DACL grants no private authority"
        );
        let mut size = sec::ACL_SIZE_INFORMATION::default();
        unsafe {
            sec::GetAclInformation(
                dacl,
                (&mut size as *mut sec::ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of_val(&size) as u32,
                sec::AclSizeInformation,
            )
        }
        .unwrap();
        assert!(size.AceCount <= 64);
        let mut entries = Vec::new();
        for index in 0..size.AceCount {
            let mut entry = std::ptr::null_mut();
            unsafe { sec::GetAce(dacl, index, &mut entry) }.unwrap();
            let ace = unsafe { &*entry.cast::<sec::ACCESS_ALLOWED_ACE>() };
            assert_eq!(
                ace.Header.AceType, 0,
                "unexpected non-allow ACE in controlled fixture"
            );
            entries.push(AceEvidence {
                kind: ace.Header.AceType,
                flags: ace.Header.AceFlags,
                mask: ace.Mask,
                sid: sid_text(sec::PSID((&ace.SidStart as *const u32).cast_mut().cast())),
            });
        }
        let mut control = 0;
        let mut revision = 0;
        unsafe { sec::GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }
            .unwrap();
        SecurityEvidence {
            owner: sid_text(owner),
            protected: control & sec::SE_DACL_PROTECTED.0 != 0,
            entries,
        }
    }
    fn set_fixture_dacl(path: &std::path::Path, text: &str, protected: bool) {
        use std::os::windows::io::AsRawHandle;
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::HANDLE,
                Security::{self as sec, Authorization as acl},
            },
        };
        let file = security_handle(path, true, true);
        let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        let mut descriptor = sec::PSECURITY_DESCRIPTOR::default();
        unsafe {
            acl::ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(wide.as_ptr()),
                acl::SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .unwrap();
        let _allocation = LocalAllocation(descriptor.0);
        let mut present = windows::core::BOOL::default();
        let mut defaulted = windows::core::BOOL::default();
        let mut dacl = std::ptr::null_mut();
        unsafe {
            sec::GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted)
        }
        .unwrap();
        assert!(present.as_bool() && !dacl.is_null());
        unsafe {
            acl::SetSecurityInfo(
                HANDLE(file.as_raw_handle()),
                acl::SE_FILE_OBJECT,
                sec::DACL_SECURITY_INFORMATION
                    | if protected {
                        sec::PROTECTED_DACL_SECURITY_INFORMATION
                    } else {
                        sec::UNPROTECTED_DACL_SECURITY_INFORMATION
                    },
                None,
                None,
                Some(dacl),
                None,
            )
        }
        .ok()
        .unwrap();
    }

    #[test]
    fn native_drive_alias_opens_real_volume_but_preserves_logical_path() {
        use std::os::windows::io::AsRawHandle;
        use windows::{
            core::PCWSTR,
            Win32::{Foundation::HANDLE, Storage::FileSystem as win},
        };
        let root = Fixture::new();
        let drive: PathBuf = root.path.components().take(2).collect();
        let drive_guard = AnchoredDirectory::open_absolute(&drive).unwrap();
        assert_eq!(drive_guard.path(), drive);
        let alias: Vec<u16> = drive
            .as_os_str()
            .encode_wide()
            .take(2)
            .chain(Some(0))
            .collect();
        let mut target = [0u16; 32768];
        let length =
            unsafe { win::QueryDosDeviceW(PCWSTR(alias.as_ptr()), Some(&mut target)) } as usize;
        assert!(length > 0 && length <= target.len());
        let end = target[..length].iter().position(|unit| *unit == 0).unwrap();
        let target = String::from_utf16(&target[..end]).unwrap();
        assert!(target.starts_with("\\Device\\HarddiskVolume"));
        let mut file = root
            .root()
            .create_new(OsStr::new("real-volume-proof"))
            .unwrap();
        file.file_mut().write_all(b"real retained volume").unwrap();
        file.flush().unwrap();
        assert_eq!(file.path(), root.path.join("real-volume-proof"));
        let mut actual = [0u16; 32768];
        let length = unsafe {
            win::GetFinalPathNameByHandleW(
                HANDLE(file.file().as_raw_handle()),
                &mut actual,
                win::VOLUME_NAME_NT,
            )
        } as usize;
        assert!(length > 0 && length < actual.len());
        let actual = String::from_utf16(&actual[..length]).unwrap();
        assert!(
            actual.starts_with(&format!("{target}\\")),
            "target={target}; actual={actual}"
        );
        assert_eq!(fs::read(file.path()).unwrap(), b"real retained volume");
        println!("QUALIFICATION drive_alias=direct_disk_volume; logical_path=preserved; actual_volume_handle=matched");
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
            "COM¹.png",
            "LPT³.txt",
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
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem as win,
        System::{Ioctl::FSCTL_SET_REPARSE_POINT, IO::DeviceIoControl},
    };
    fn junction_data(target: &std::path::Path) -> Vec<u8> {
        // Microsoft mount-point reparse buffer, not a symbolic-link tag.
        // Exercise the same empty-directory conversion used by junctions.
        let substitute: Vec<u16> = format!("\\??\\{}", target.display())
            .encode_utf16()
            .collect();
        let print: Vec<u16> = target.as_os_str().encode_wide().collect();
        let mut names = substitute.clone();
        names.push(0);
        names.extend(&print);
        names.push(0);
        let mut data = Vec::new();
        data.extend(0xA0000003u32.to_le_bytes()); // IO_REPARSE_TAG_MOUNT_POINT
        data.extend((8u16 + (names.len() * 2) as u16).to_le_bytes());
        data.extend(0u16.to_le_bytes());
        data.extend(0u16.to_le_bytes()); // SubstituteNameOffset
        data.extend(((substitute.len() * 2) as u16).to_le_bytes());
        data.extend((((substitute.len() + 1) * 2) as u16).to_le_bytes());
        data.extend(((print.len() * 2) as u16).to_le_bytes());
        for unit in names {
            data.extend(unit.to_le_bytes());
        }
        data
    }
    fn attempt_reparse_conversion(
        path: &std::path::Path,
        access: u32,
        data: &[u8],
    ) -> std::io::Result<()> {
        let directory = fs::OpenOptions::new()
            .access_mode(access)
            .share_mode((win::FILE_SHARE_READ | win::FILE_SHARE_WRITE | win::FILE_SHARE_DELETE).0)
            .custom_flags(win::FILE_FLAG_BACKUP_SEMANTICS.0 | win::FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(path)?;
        let mut returned = 0;
        unsafe {
            DeviceIoControl(
                HANDLE(directory.as_raw_handle()),
                FSCTL_SET_REPARSE_POINT,
                Some(data.as_ptr().cast()),
                data.len() as u32,
                None,
                0,
                Some(&mut returned),
                None,
            )
        }
        .map_err(std::io::Error::from)
    }
    #[test]
    fn native_held_empty_ancestry_conversion_never_follows_substituted_target() {
        use windows::Win32::Foundation::GENERIC_WRITE;
        let root = Fixture::new();
        let target = Fixture::new();
        {
            let mut marker = target
                .root()
                .create_new(OsStr::new("target-marker"))
                .unwrap();
            marker
                .file_mut()
                .write_all(b"substitute remains untouched")
                .unwrap();
            marker.flush().unwrap();
        }
        let data = junction_data(&target.path);
        let mut positive_controls = 0;
        for (label, access) in [
            ("full-write", GENERIC_WRITE.0),
            (
                "attributes-only",
                (win::FILE_READ_ATTRIBUTES | win::FILE_WRITE_ATTRIBUTES).0,
            ),
            (
                "attributes-and-EA",
                (win::FILE_READ_ATTRIBUTES | win::FILE_WRITE_ATTRIBUTES | win::FILE_WRITE_EA).0,
            ),
        ] {
            let control_path = root.path.join(format!("unheld-{label}"));
            fs::create_dir(&control_path).unwrap();
            let control = attempt_reparse_conversion(&control_path, access, &data);
            let held_path = root.path.join(format!("held-empty-{label}"));
            fs::create_dir(&held_path).unwrap();
            let held = AnchoredDirectory::open_absolute(&held_path).unwrap();
            let result = attempt_reparse_conversion(&held_path, access, &data);
            println!("QUALIFICATION in_place_reparse_access={label}; unheld_control={control:?}; held_attempt={result:?}");
            if control.is_ok() {
                positive_controls += 1;
            }
            if result.is_ok() {
                assert!(
                    AnchoredDirectory::open_absolute(&held_path).is_err(),
                    "converted path reopened as ordinary ancestry for {label}"
                );
                assert!(
                    held.create_new(OsStr::new("must-not-follow-target"))
                        .is_err(),
                    "retained converted directory allowed publication for {label}"
                );
                assert!(
                    held.open_regular(OsStr::new("target-marker"), false)
                        .is_err(),
                    "retained converted directory followed target read for {label}"
                );
            } else {
                let mut still_owned = held.create_new(OsStr::new("still-owned")).unwrap();
                still_owned
                    .file_mut()
                    .write_all(b"original held directory")
                    .unwrap();
                still_owned.flush().unwrap();
                assert_eq!(
                    fs::read(held_path.join("still-owned")).unwrap(),
                    b"original held directory"
                );
            }
            assert_eq!(
                fs::read_dir(&target.path).unwrap().count(),
                1,
                "substitute target changed for {label}"
            );
            assert_eq!(
                fs::read(target.path.join("target-marker")).unwrap(),
                b"substitute remains untouched"
            );
            drop(held);
            if result.is_ok() {
                fs::remove_dir(&held_path).unwrap();
            }
            if control.is_ok() {
                fs::remove_dir(&control_path).unwrap();
            }
        }
        // A privilege/payload failure on every unheld attempt cannot be used as
        // evidence that retained handles prevented conversion. Fail honestly.
        assert!(positive_controls > 0, "no supported unheld native conversion; ancestry conversion boundary remains unqualified");
    }
    #[test]
    fn native_check_to_relative_create_link_rename_replace_race_never_writes_substitute() {
        use super::windows_artifact_namespace::{at_native_boundary, NativeBoundary};
        use std::sync::{atomic::AtomicBool, Arc};
        for operation in ["create", "link"] {
            let root = Fixture::new();
            let target = Fixture::new();
            {
                let mut marker = target
                    .root()
                    .create_new(OsStr::new("target-marker"))
                    .unwrap();
                marker
                    .file_mut()
                    .write_all(b"untouched substitute marker")
                    .unwrap();
                marker.flush().unwrap();
            }
            let held_path = root.path.join(format!("empty-destination-{operation}"));
            fs::create_dir(&held_path).unwrap();
            let destination = AnchoredDirectory::open_absolute(&held_path).unwrap();
            let data = junction_data(&target.path);
            let converted = Arc::new(AtomicBool::new(false));
            let observed = converted.clone();
            let convert_path = held_path.clone();
            let callback = move || {
                // The module invokes this after opened-parent validation and
                // immediately before the kernel operation, not before checking.
                attempt_reparse_conversion(
                    &convert_path,
                    (win::FILE_READ_ATTRIBUTES | win::FILE_WRITE_ATTRIBUTES).0,
                    &data,
                )
                .unwrap();
                observed.store(true, Ordering::Release);
            };
            if operation == "create" {
                let result = at_native_boundary(NativeBoundary::Create, callback, || {
                    destination.create_new(OsStr::new("must-not-create"))
                });
                assert!(
                    result.is_err(),
                    "check/use create accepted converted ancestry"
                );
            } else {
                let mut source = root
                    .root()
                    .create_new(OsStr::new("source.pending"))
                    .unwrap();
                source.file_mut().write_all(b"retained paid bytes").unwrap();
                source.flush().unwrap();
                let result = at_native_boundary(NativeBoundary::Link, callback, || {
                    destination.hardlink_noreplace(source, OsStr::new("must-not-link"))
                });
                assert!(
                    result.is_err(),
                    "check/use link accepted converted ancestry"
                );
                assert_eq!(
                    fs::read(root.path.join("source.pending")).unwrap(),
                    b"retained paid bytes"
                );
            }
            assert!(
                converted.load(Ordering::Acquire),
                "native boundary callback did not execute"
            );
            assert!(AnchoredDirectory::open_absolute(&held_path).is_err());
            assert_eq!(
                fs::read_dir(&target.path).unwrap().count(),
                1,
                "{operation} mutated substituted target"
            );
            assert_eq!(
                fs::read(target.path.join("target-marker")).unwrap(),
                b"untouched substitute marker"
            );
            println!("QUALIFICATION check_use_race={operation}; conversion=after_validation; substitute_mutations=zero");
            drop(destination);
            fs::remove_dir(held_path).unwrap();
        }
        for operation in ["rename", "replace"] {
            let root = Fixture::new();
            let target = Fixture::new();
            {
                let mut marker = target
                    .root()
                    .create_new(OsStr::new("target-marker"))
                    .unwrap();
                marker
                    .file_mut()
                    .write_all(b"untouched substitute marker")
                    .unwrap();
                marker.flush().unwrap();
            }
            if operation == "replace" {
                let mut original = root.root().create_new(OsStr::new("final")).unwrap();
                original
                    .file_mut()
                    .write_all(b"original configuration")
                    .unwrap();
                original.flush().unwrap();
            }
            let mut pending = root
                .root()
                .create_new(OsStr::new("source.pending"))
                .unwrap();
            pending
                .file_mut()
                .write_all(b"exact new publication")
                .unwrap();
            pending.flush().unwrap();
            let data = junction_data(&target.path);
            let attempted = Arc::new(AtomicBool::new(false));
            let observed = attempted.clone();
            let root_path = root.path.clone();
            let callback = move || {
                // Unlike an empty hardlink destination, the owned source file
                // keeps this parent nonempty and denies deletion through its
                // retained file handle. Exercise the real conversion attempt.
                let result = attempt_reparse_conversion(
                    &root_path,
                    (win::FILE_READ_ATTRIBUTES | win::FILE_WRITE_ATTRIBUTES).0,
                    &data,
                );
                println!("QUALIFICATION check_use_nonempty_parent={operation}; conversion_attempt={result:?}");
                assert!(
                    result.is_err(),
                    "owned nonempty rename parent converted at kernel boundary"
                );
                observed.store(true, Ordering::Release);
            };
            let published = at_native_boundary(NativeBoundary::Rename, callback, || {
                if operation == "replace" {
                    root.root().replace_regular(pending, OsStr::new("final"))
                } else {
                    root.root().publish_noreplace(pending, OsStr::new("final"))
                }
            })
            .unwrap();
            assert!(
                attempted.load(Ordering::Acquire),
                "rename kernel boundary callback did not execute"
            );
            published.flush().unwrap();
            assert_eq!(published.path(), root.path.join("final"));
            assert_eq!(
                fs::read(published.path()).unwrap(),
                b"exact new publication"
            );
            assert!(!root.path.join("source.pending").exists());
            assert_eq!(fs::read_dir(&target.path).unwrap().count(), 1);
            assert_eq!(
                fs::read(target.path.join("target-marker")).unwrap(),
                b"untouched substitute marker"
            );
            println!("QUALIFICATION check_use_race={operation}; owned_original_namespace=preserved; substitute_mutations=zero");
        }
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
    fn native_hardlink_retains_original_and_both_namespace_guards_without_replacement() {
        let mut source_root = Fixture::new();
        let mut target_root = Fixture::new();
        let source = source_root.directory.take().unwrap();
        let target = target_root.directory.take().unwrap();
        let mut pending = source.create_new(OsStr::new("source.pending")).unwrap();
        pending
            .file_mut()
            .write_all(b"retained exact bytes")
            .unwrap();
        let linked = target.hardlink_noreplace(pending, OsStr::new("x")).unwrap();
        linked.flush().unwrap();
        assert_eq!(linked.file().metadata().unwrap().len(), 20);
        assert_eq!(fs::read(linked.path()).unwrap(), b"retained exact bytes");
        assert_eq!(
            fs::read(linked.source_path()).unwrap(),
            b"retained exact bytes"
        );
        let mut second = source.create_new(OsStr::new("second.pending")).unwrap();
        second.file_mut().write_all(b"must never replace").unwrap();
        assert!(target.hardlink_noreplace(second, OsStr::new("x")).is_err());
        drop(source);
        drop(target);
        let source_moved = source_root.path.with_extension("moved");
        let target_moved = target_root.path.with_extension("moved");
        assert!(fs::rename(&source_root.path, &source_moved).is_err());
        assert!(fs::rename(&target_root.path, &target_moved).is_err());
        drop(linked);
        fs::rename(&source_root.path, &source_moved).unwrap();
        fs::rename(&target_root.path, &target_moved).unwrap();
        source_root.path = source_moved;
        target_root.path = target_moved;
        assert_eq!(
            fs::read(source_root.path.join("source.pending")).unwrap(),
            b"retained exact bytes"
        );
        assert_eq!(
            fs::read(target_root.path.join("x")).unwrap(),
            b"retained exact bytes"
        );
    }
    #[test]
    fn native_hardlink_crash_retains_source_and_published_exact_bytes() {
        let root = Fixture::new();
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "native_tests::native_child_crash_boundary",
                "--nocapture",
            ])
            .env("TE_NAMESPACE_FIXTURE_ROOT", &root.path)
            .env("TE_NAMESPACE_FIXTURE_STAGE", "after-hardlink")
            .output()
            .unwrap();
        assert_eq!(
            child.status.code(),
            Some(91),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        assert_eq!(
            fs::read(root.path.join("crash-pending")).unwrap(),
            b"original-paid-output-fixture"
        );
        assert_eq!(
            fs::read(root.path.join("crash-link")).unwrap(),
            b"original-paid-output-fixture"
        );
    }
    #[test]
    fn native_readonly_input_has_no_flush_publish_hardlink_or_delete_authority() {
        let root = Fixture::new();
        {
            let mut source = root.root().create_new(OsStr::new("input")).unwrap();
            source.file_mut().write_all(b"readonly source").unwrap();
            source.flush().unwrap();
        }
        let mut input =
            AnchoredDirectory::open_absolute_readonly(&root.path.join("input")).unwrap();
        let mut bytes = vec![];
        input.file_mut().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"readonly source");
        assert!(input.flush().is_err());
        assert!(input.file_mut().write_all(b"mutated").is_err());
        assert!(root
            .root()
            .hardlink_noreplace(input, OsStr::new("forbidden-link"))
            .is_err());
        let input = AnchoredDirectory::open_absolute_readonly(&root.path.join("input")).unwrap();
        assert!(root
            .root()
            .publish_noreplace(input, OsStr::new("forbidden-rename"))
            .is_err());
        let input = AnchoredDirectory::open_absolute_readonly(&root.path.join("input")).unwrap();
        assert!(root.root().delete_regular(input).is_err());
        assert_eq!(
            fs::read(root.path.join("input")).unwrap(),
            b"readonly source"
        );
        assert_eq!(fs::read_dir(&root.path).unwrap().count(), 1);
    }
    #[test]
    fn native_private_creation_and_repair_reject_foreign_dacl_before_use() {
        let root = Fixture::new();
        let private = root
            .root()
            .create_private_directory(OsStr::new("private"))
            .unwrap();
        private.verify_private_directory().unwrap();
        let before = security_evidence(private.path(), true);
        set_fixture_dacl(private.path(), "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;WD)", true);
        let foreign = security_evidence(private.path(), true);
        assert_eq!(foreign.owner, before.owner);
        assert!(foreign.protected);
        assert_eq!(foreign.entries.len(), 2);
        assert!(foreign
            .entries
            .iter()
            .all(|entry| entry.kind == 0 && entry.flags == 3 && entry.mask == 0x1f01ff));
        let mut principals: Vec<_> = foreign
            .entries
            .iter()
            .map(|entry| entry.sid.as_str())
            .collect();
        principals.sort();
        assert_eq!(principals, ["S-1-1-0", "S-1-5-18"]);
        assert!(private
            .verify_private_directory()
            .unwrap_err()
            .to_string()
            .contains("foreign principal"));
        private.secure_private_directory().unwrap();
        private.verify_private_directory().unwrap();
        let child = private
            .create_private_directory(OsStr::new("child"))
            .unwrap();
        child.verify_private_directory().unwrap();
        let mut file = child.create_new(OsStr::new("owned")).unwrap();
        file.file_mut().write_all(b"private output").unwrap();
        file.flush().unwrap();
    }
    #[test]
    fn native_correct_two_principal_acl_without_protection_is_refused() {
        let root = Fixture::new();
        let container = root
            .root()
            .create_private_directory(OsStr::new("noninheriting-container"))
            .unwrap();
        let owner = security_evidence(container.path(), true).owner;
        // No inheritable ACEs in the parent: UNPROTECTED must not silently add
        // unrelated inherited entries and turn this into a cardinality test.
        set_fixture_dacl(
            container.path(),
            &format!("D:P(A;;FA;;;SY)(A;;FA;;;{owner})"),
            true,
        );
        let private = container
            .create_private_directory(OsStr::new("private"))
            .unwrap();
        let correct = format!("D:(A;OICI;FA;;;SY)(A;OICI;FA;;;{owner})");
        set_fixture_dacl(private.path(), &correct, false);
        let actual = security_evidence(private.path(), true);
        assert_eq!(actual.owner, owner);
        assert!(!actual.protected);
        assert_eq!(actual.entries.len(), 2);
        assert!(actual
            .entries
            .iter()
            .all(|entry| entry.kind == 0 && entry.flags == 3 && entry.mask == 0x1f01ff));
        let mut principals: Vec<_> = actual
            .entries
            .iter()
            .map(|entry| entry.sid.clone())
            .collect();
        principals.sort();
        let mut expected = vec!["S-1-5-18".to_owned(), owner];
        expected.sort();
        assert_eq!(principals, expected);
        assert!(private
            .verify_private_directory()
            .unwrap_err()
            .to_string()
            .contains("inherits a foreign DACL"));
        private.secure_private_directory().unwrap();
        private.verify_private_directory().unwrap();
    }
    #[test]
    fn native_created_private_child_file_inherits_only_system_and_current_user() {
        let root = Fixture::new();
        let private = root
            .root()
            .create_private_directory(OsStr::new("private-output"))
            .unwrap();
        private.verify_private_directory().unwrap();
        let owner = security_evidence(private.path(), true).owner;
        let file_path;
        {
            let mut writer = private.create_new(OsStr::new("output-or-config")).unwrap();
            writer.file_mut().write_all(b"exact private bytes").unwrap();
            writer.flush().unwrap();
            file_path = writer.path().to_owned();
        }
        let actual = security_evidence(&file_path, false);
        assert_eq!(actual.owner, owner);
        assert_eq!(actual.entries.len(), 2);
        assert!(
            actual.entries.iter().all(|entry| entry.kind == 0
                && entry.mask == 0x1f01ff
                && entry.flags & 0x10 != 0
                && entry.flags & 0x08 == 0),
            "file ACEs must be inherited and effective: {actual:?}"
        );
        let mut principals: Vec<_> = actual
            .entries
            .iter()
            .map(|entry| entry.sid.clone())
            .collect();
        principals.sort();
        let mut expected = vec!["S-1-5-18".to_owned(), owner];
        expected.sort();
        assert_eq!(principals, expected);
        assert_eq!(fs::read(&file_path).unwrap(), b"exact private bytes");
        println!("QUALIFICATION child_file_DACL=two_effective_inherited_ACE; principals=SYSTEM_and_current_user_only; owner=current_user");
    }
    #[test]
    fn native_fresh_private_ancestry_survives_reopen_and_refuses_volume_root_security() {
        let root = Fixture::new();
        let path = root
            .path
            .join("fresh-one")
            .join("fresh-two")
            .join("owned-root");
        let created = AnchoredDirectory::ensure_private_absolute(&path).unwrap();
        created.verify_private_directory().unwrap();
        let mut file = created.create_new(OsStr::new("proof")).unwrap();
        file.file_mut()
            .write_all(b"fresh ancestors exact bytes")
            .unwrap();
        file.flush().unwrap();
        drop(file);
        drop(created);
        let reopened = AnchoredDirectory::ensure_private_absolute(&path).unwrap();
        reopened.verify_private_directory().unwrap();
        assert_eq!(
            fs::read(reopened.path().join("proof")).unwrap(),
            b"fresh ancestors exact bytes"
        );
        let drive: PathBuf = root.path.components().take(2).collect();
        assert!(AnchoredDirectory::ensure_private_absolute(&drive).is_err());
        assert!(AnchoredDirectory::ensure_private_absolute(
            &root.path.join("must-not-create").join("CON")
        )
        .is_err());
        assert!(!root.path.join("must-not-create").exists());
        let mut oversized = root.path.join("too-many-must-not-create");
        for _ in 0..130 {
            oversized.push("component");
        }
        assert!(AnchoredDirectory::ensure_private_absolute(&oversized).is_err());
        assert!(!root.path.join("too-many-must-not-create").exists());
    }
    #[test]
    fn native_config_replacement_preserves_exact_new_bytes_and_refuses_reparse_target() {
        let root = Fixture::new();
        {
            let mut old = root.root().create_new(OsStr::new("config.json")).unwrap();
            old.file_mut().write_all(b"old config").unwrap();
            old.flush().unwrap();
        }
        let mut pending = root
            .root()
            .create_new(OsStr::new("config.pending"))
            .unwrap();
        pending.file_mut().write_all(b"exact new config").unwrap();
        let committed = root
            .root()
            .replace_regular(pending, OsStr::new("config.json"))
            .unwrap();
        committed.flush().unwrap();
        assert_eq!(fs::read(committed.path()).unwrap(), b"exact new config");
        assert!(!root.path.join("config.pending").exists());
        drop(committed);
        let other = Fixture::new();
        let junction = root.path.join("foreign");
        assert!(Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&other.path)
            .output()
            .unwrap()
            .status
            .success());
        let pending = root
            .root()
            .create_new(OsStr::new("refused.pending"))
            .unwrap();
        assert!(root
            .root()
            .replace_regular(pending, OsStr::new("foreign"))
            .is_err());
        assert_eq!(fs::read_dir(&other.path).unwrap().count(), 0);
        fs::remove_dir(junction).unwrap();
    }
    #[test]
    fn native_gc_retirement_and_physical_unlink_never_fabricate_durable_directory_barrier() {
        let root = Fixture::new();
        let mut file = root
            .root()
            .create_new(OsStr::new("released-output"))
            .unwrap();
        file.file_mut().write_all(b"released bytes").unwrap();
        let tombstone = root
            .root()
            .publish_noreplace(file, OsStr::new("released-output.delete"))
            .unwrap();
        assert!(!root.path.join("released-output").exists());
        assert_eq!(fs::read(tombstone.path()).unwrap(), b"released bytes");
        let outcome = root.root().delete_regular(tombstone).unwrap();
        assert_eq!(outcome, DeletionOutcome::RemovedDurabilityUnqualified);
        assert!(!root.path.join("released-output.delete").exists());
        println!("QUALIFICATION physical_POSIX_unlink=observed; final_deletion_durability=unqualified_cleanup_authority_retained");
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
        if std::env::var("TE_NAMESPACE_FIXTURE_STAGE").unwrap() == "after-hardlink" {
            let linked = root
                .hardlink_noreplace(pending, OsStr::new("crash-link"))
                .unwrap();
            linked.flush().unwrap();
            std::process::exit(91);
        }
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
