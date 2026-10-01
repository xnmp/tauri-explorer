use super::*;
use std::{
    fs,
    os::unix::fs::symlink,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[test]
fn exact_handle_blocks_competitors_and_drop_leaves_recoverable_evidence() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = Directory::open(temporary.path()).unwrap();
    let held = OperationLock::create(&directory).unwrap();
    let identity = held.identity.clone();
    assert!(matches!(
        OperationLock::acquire(&directory, &identity).unwrap(),
        LockAttempt::Busy
    ));
    drop(held);
    let claimed = OperationLock::acquire(&directory, &identity).unwrap();
    assert!(matches!(claimed, LockAttempt::Acquired(_)));
    assert!(temporary.path().join(&identity.name).is_file());
    assert!(matches!(
        OperationLock::acquire(&directory, &identity).unwrap(),
        LockAttempt::Busy
    ));
    drop(claimed);
    assert!(matches!(
        OperationLock::acquire(&directory, &identity).unwrap(),
        LockAttempt::Acquired(_)
    ));
}

#[test]
fn missing_replaced_symlinked_and_modified_locks_are_unknown() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = Directory::open(temporary.path()).unwrap();
    let held = OperationLock::create(&directory).unwrap();
    let identity = held.identity.clone();
    drop(held);
    let path = temporary.path().join(&identity.name);
    fs::rename(&path, temporary.path().join("retained")).unwrap();
    assert!(OperationLock::acquire(&directory, &identity).is_err());
    fs::write(&path, hex::decode(&identity.nonce).unwrap()).unwrap();
    assert!(OperationLock::acquire(&directory, &identity).is_err());
    fs::remove_file(&path).unwrap();
    symlink("retained", &path).unwrap();
    assert!(OperationLock::acquire(&directory, &identity).is_err());
    fs::remove_file(&path).unwrap();
    fs::rename(temporary.path().join("retained"), &path).unwrap();
    fs::write(&path, [0; 32]).unwrap();
    assert!(OperationLock::acquire(&directory, &identity).is_err());
}

#[test]
fn actual_process_exit_releases_only_the_exact_os_lock() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = Directory::open(temporary.path()).unwrap();
    let held = OperationLock::create(&directory).unwrap();
    let identity = held.identity.clone();
    drop(held);
    let identity_path = temporary.path().join("identity.json");
    fs::write(&identity_path, serde_json::to_vec(&identity).unwrap()).unwrap();
    let ready_path = temporary.path().join("ready");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "files::recovery::locks::tests::subprocess_lock_holder",
            "--ignored",
            "--nocapture",
        ])
        .env("EXPLORER_RECOVERY_LOCK_TEST", temporary.path())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready_path.exists() {
        if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("lock child did not acquire ownership");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let blocked = matches!(
        OperationLock::acquire(&directory, &identity).unwrap(),
        LockAttempt::Busy
    );
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(blocked, "independent process must hold the exact lock");
    assert!(matches!(
        OperationLock::acquire(&directory, &identity).unwrap(),
        LockAttempt::Acquired(_)
    ));
    assert!(temporary.path().join(&identity.name).exists());
}

#[test]
#[ignore = "subprocess helper controlled by actual_process_exit_releases_only_the_exact_os_lock"]
fn subprocess_lock_holder() {
    let root = std::env::var_os("EXPLORER_RECOVERY_LOCK_TEST").expect("parent fixture");
    let root = std::path::Path::new(&root);
    let directory = Directory::open(root).unwrap();
    let identity = serde_json::from_slice(&fs::read(root.join("identity.json")).unwrap()).unwrap();
    let LockAttempt::Acquired(_held) = OperationLock::acquire(&directory, &identity).unwrap()
    else {
        panic!("parent released ownership");
    };
    fs::write(root.join("ready"), b"owned").unwrap();
    loop {
        std::thread::park();
    }
}
