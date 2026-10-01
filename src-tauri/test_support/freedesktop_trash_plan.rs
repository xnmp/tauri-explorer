use super::*;
use std::{fs, os::unix::fs::PermissionsExt};

// Supply a private synthetic mount placement to the real prepared executor.
// These tests exercise its filesystem effects, not the kernel's mount discovery.
fn mounted_item(temporary: &Path, mount: &Mount) -> (Prepared, PathBuf) {
    let source = temporary.join("source");
    fs::write(&source, b"source bytes").unwrap();
    let context = Context {
        mounts: crate::files::trash_mounts::MountSnapshot::read().unwrap(),
        data_home: temporary.join("data"),
    };
    let mut prepared = context
        .prepare(&source, &mut super::super::random_bytes)
        .unwrap();
    open_mounted(mount).unwrap();
    let probes = LayoutProbe::mounted(mount).unwrap();
    prepared.layout = std::sync::Arc::new(probes.primary.plan);
    prepared.fallback = probes.fallback.map(|probe| std::sync::Arc::new(probe.plan));
    (prepared, source)
}

fn mounted_fixture() -> (tempfile::TempDir, Mount, PathBuf, PathBuf) {
    let temporary = tempfile::tempdir().unwrap();
    let shared = temporary.path().join(".Trash");
    fs::create_dir(&shared).unwrap();
    fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o1777)).unwrap();
    let uid = unsafe { libc::geteuid() };
    let personal = temporary.path().join(format!(".Trash-{uid}"));
    let mount = Mount {
        id: 1,
        parent_id: 0,
        root: PathBuf::from("/"),
        mount_point: temporary.path().to_owned(),
        filesystem: OsString::from("fixture"),
    };
    (temporary, mount, shared, personal)
}

#[test]
fn declared_personal_fallback_survives_late_shared_layout_failure() {
    for partial in [false, true] {
        let (_temporary, mount, shared, personal) = mounted_fixture();
        let probes = LayoutProbe::mounted(&mount).unwrap();
        assert!(fs::read_dir(&shared).unwrap().next().is_none());
        assert!(
            !personal.exists(),
            "preparing a fallback must not create it"
        );
        let user_root = shared.join(unsafe { libc::geteuid() }.to_string());
        if partial {
            fs::create_dir(&user_root).unwrap();
            fs::set_permissions(&user_root, std::fs::Permissions::from_mode(0o700)).unwrap();
            fs::write(user_root.join("info"), b"occupied").unwrap();
        } else {
            fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o777)).unwrap();
        }
        let directories =
            execute_layouts(probes.primary.plan, probes.fallback.map(|probe| probe.plan)).unwrap();
        assert_eq!(directories.root_path, personal);
        assert!(personal.join("info").is_dir());
        assert!(personal.join("files").is_dir());
        if partial {
            assert_eq!(fs::read(user_root.join("info")).unwrap(), b"occupied");
        } else {
            assert!(!user_root.exists());
        }
    }
}

#[test]
fn an_appeared_layout_is_not_silently_permission_repaired() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    let probe = LayoutProbe::home(&data).unwrap();
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(probe.plan.execute().is_err());
    assert_eq!(fs::metadata(&data).unwrap().mode() & 0o777, 0o755);
    assert!(fs::read_dir(&data).unwrap().next().is_none());
}

#[test]
fn prepared_personal_destination_survives_shared_metadata_and_payload_collisions() {
    for location in ["temporary", "info", "payload"] {
        let (temporary, mount, shared, personal) = mounted_fixture();
        let (prepared, source) = mounted_item(temporary.path(), &mount);
        let name = prepared.name.clone();
        let shared_root = shared.join(unsafe { libc::geteuid() }.to_string());
        let occupied = match location {
            "temporary" => shared_root.join("info").join(&prepared.temporary_name),
            "info" => shared_root.join("info").join(&prepared.info_name),
            _ => shared_root.join("files").join(&prepared.name),
        };
        fs::write(&occupied, b"retain occupant").unwrap();
        let result = prepared
            .execute_with(super::super::rename_noreplace_at, |_, _, _| Ok(()))
            .unwrap();
        assert!(!source.exists());
        assert_eq!(fs::read(&occupied).unwrap(), b"retain occupant");
        assert_eq!(
            fs::read(personal.join("files").join(&name)).unwrap(),
            b"source bytes"
        );
        let crate::files::trash_artifact::TrashArtifact::Freedesktop {
            root,
            name: receipt_name,
            ..
        } = result.artifact.as_deref().unwrap()
        else {
            panic!("exact receipt");
        };
        assert_eq!(root, &personal);
        assert_eq!(receipt_name, &name);
        assert_eq!(
            fs::read_dir(shared_root.join("info")).unwrap().count()
                + fs::read_dir(shared_root.join("files")).unwrap().count(),
            1
        );
    }
}

#[test]
fn failed_shared_metadata_cleanup_stops_before_personal_fallback() {
    let (temporary, mount, shared, personal) = mounted_fixture();
    let (prepared, source) = mounted_item(temporary.path(), &mount);
    let shared_root = shared.join(unsafe { libc::geteuid() }.to_string());
    let info = shared_root.join("info").join(&prepared.info_name);
    let retained = shared_root.join("info/retained");
    let error = prepared
        .execute_with(
            |_, _, _, _| {
                fs::rename(&info, &retained)?;
                fs::create_dir(&info)?;
                fs::write(info.join("occupant"), b"retain directory")?;
                Err(io::Error::from_raw_os_error(libc::EIO))
            },
            |_, _, _| Ok(()),
        )
        .unwrap_err();
    assert!(matches!(error, AppError::MutationUncertain(_)));
    assert_eq!(fs::read(&source).unwrap(), b"source bytes");
    assert_eq!(
        fs::read(info.join("occupant")).unwrap(),
        b"retain directory"
    );
    assert!(retained.is_file());
    assert!(
        !personal.exists(),
        "cleanup uncertainty must not advance to the other destination"
    );
}
