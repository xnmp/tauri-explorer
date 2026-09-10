use super::FileLock;
use std::{
    fs::{self, File},
    io::Read,
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const NONCE: [u8; 32] = [0xa5; 32];
const DEADLINE: Duration = Duration::from_secs(5);

#[test]
fn live_lock_keeps_bounded_evidence_readable_and_rejects_independent_contenders() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owner.lock");
    fs::write(&path, NONCE).unwrap();
    let held = FileLock::acquire(File::open(&path).unwrap()).unwrap();
    for _ in 0..8 {
        let mut bytes = Vec::new();
        File::open(&path)
            .unwrap()
            .take(33)
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(
            bytes, NONCE,
            "validation must remain possible under active ownership"
        );
        assert!(FileLock::try_acquire(File::open(&path).unwrap())
            .unwrap()
            .is_none());
    }
    drop(held);
    let next = FileLock::try_acquire(File::open(&path).unwrap())
        .unwrap()
        .expect("ownership released");
    assert!(FileLock::try_acquire(File::open(&path).unwrap())
        .unwrap()
        .is_none());
    drop(next);
    assert_eq!(
        fs::read(path).unwrap(),
        NONCE,
        "lock retirement preserves evidence and its length"
    );
}

#[test]
fn blocking_waiter_acquires_after_the_current_owner_releases() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("gate.lock");
    fs::write(&path, b"").unwrap();
    let held = FileLock::acquire(File::open(&path).unwrap()).unwrap();
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (acquired_tx, acquired_rx) = mpsc::sync_channel(1);
    let thread = std::thread::spawn(move || {
        let file = File::open(path).unwrap();
        started_tx.send(()).unwrap();
        let _held = FileLock::acquire(file).unwrap();
        acquired_tx.send(()).unwrap();
    });
    started_rx.recv_timeout(DEADLINE).unwrap();
    assert!(matches!(
        acquired_rx.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(held);
    acquired_rx.recv_timeout(DEADLINE).unwrap();
    thread.join().unwrap();
}

#[test]
fn unwind_releases_ownership_without_removing_evidence() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owner.lock");
    fs::write(&path, NONCE).unwrap();
    assert!(std::panic::catch_unwind(|| {
        let _held = FileLock::acquire(File::open(&path).unwrap()).unwrap();
        panic!("injected owner unwind");
    })
    .is_err());
    assert!(FileLock::try_acquire(File::open(&path).unwrap())
        .unwrap()
        .is_some());
    assert_eq!(fs::read(path).unwrap(), NONCE);
}

struct ChildOwner(Child);
impl Drop for ChildOwner {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[test]
fn process_termination_releases_the_exact_lock_and_preserves_readable_evidence() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("owner.lock");
    let ready = root.path().join("ready");
    fs::write(&path, NONCE).unwrap();
    // Derive the libtest path so actual-source platform harnesses run this
    // contract too, rather than succeeding with a nonexistent test filter.
    let module = module_path!().split_once("::").unwrap().1;
    let helper = format!("{module}::subprocess_lock_holder");
    let mut child = ChildOwner(
        Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &helper, "--ignored", "--nocapture"])
            .env("EXPLORER_RECOVERY_FILE_LOCK_ROOT", root.path())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + DEADLINE;
    while !ready.exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "lock holder exited before readiness"
        );
        assert!(
            Instant::now() < deadline,
            "lock holder did not become ready"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .unwrap()
        .take(33)
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, NONCE);
    assert!(FileLock::try_acquire(File::open(&path).unwrap())
        .unwrap()
        .is_none());
    child.0.kill().unwrap();
    child.0.wait().unwrap();
    let deadline = Instant::now() + DEADLINE;
    let _claimed = loop {
        if let Some(held) = FileLock::try_acquire(File::open(&path).unwrap()).unwrap() {
            break held;
        }
        assert!(
            Instant::now() < deadline,
            "OS did not release terminated ownership"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(fs::read(path).unwrap(), NONCE);
}

#[test]
#[ignore = "owned subprocess helper for process_termination_releases_the_exact_lock_and_preserves_readable_evidence"]
fn subprocess_lock_holder() {
    let root = std::env::var_os("EXPLORER_RECOVERY_FILE_LOCK_ROOT").expect("parent fixture");
    let root = std::path::Path::new(&root);
    let _held = FileLock::acquire(File::open(root.join("owner.lock")).unwrap()).unwrap();
    fs::write(root.join("ready"), b"owned").unwrap();
    loop {
        std::thread::park();
    }
}
