//! Crash acceptance for the durable move executor. Every boundary is a real
//! process kill between a native effect and the checkpoint that records it.
//!
//! The single non-negotiable assertion at every boundary: the user's bytes are
//! reachable somewhere. No kill may leave both endpoints absent.
use super::*;
use crate::files::recovery::{coordinator::Coordinator, forward_move::PreparedMove};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const PAYLOAD: &[u8] = b"relocated payload";
const DISPLACED: &[u8] = b"displaced payload";
const FIXTURE: &str = "EXPLORER_MOVE_CRASH_FIXTURE";
const SOURCE_ROOT: &str = "EXPLORER_MOVE_CRASH_SOURCE_ROOT";
const BOUNDARY: &str = "EXPLORER_MOVE_CRASH_BOUNDARY";

struct Uninterrupted;
impl crate::files::anchored_copy::CopyProgress for Uninterrupted {
    fn check_cancelled(&mut self) -> Result<(), AppError> {
        Ok(())
    }
    fn advance(&mut self, _: u64, _: &Path) -> Result<(), AppError> {
        Ok(())
    }
}

/// `to/` always lives in the fixture directory; `from/` lives on a second
/// filesystem for the cross-filesystem boundaries.
fn layout(fixture: &Path, source_root: Option<&Path>) -> (PathBuf, PathBuf) {
    let base = fs::canonicalize(fixture).unwrap();
    let from = source_root
        .map(|root| fs::canonicalize(root).unwrap())
        .unwrap_or_else(|| base.clone())
        .join("from");
    (from, base.join("to"))
}

fn shared_filesystem() -> Option<tempfile::TempDir> {
    let root = Path::new("/dev/shm");
    if !root.is_dir() {
        eprintln!("SKIPPED cross-filesystem move crash boundary: /dev/shm is unavailable");
        return None;
    }
    let shared = tempfile::tempdir_in(root).unwrap();
    let base = std::env::temp_dir();
    use std::os::unix::fs::MetadataExt;
    if fs::metadata(&base).unwrap().dev() == fs::metadata(shared.path()).unwrap().dev() {
        eprintln!("SKIPPED cross-filesystem move crash boundary: one shared device");
        return None;
    }
    Some(shared)
}

/// Boundaries reached by a same-filesystem overwriting move, then by a
/// cross-filesystem move, then by the record's own inverse.
fn cross_filesystem(boundary: &str) -> bool {
    matches!(boundary, "stage" | "park" | "remove")
}

fn overwriting(boundary: &str) -> bool {
    matches!(boundary, "root" | "manifest" | "displace" | "publish")
}

#[test]
#[ignore = "spawned by the move crash boundary test"]
fn subprocess_mover() {
    let fixture = PathBuf::from(std::env::var_os(FIXTURE).expect("parent fixture"));
    let source_root = std::env::var_os(SOURCE_ROOT).map(PathBuf::from);
    let boundary = std::env::var(BOUNDARY).expect("parent boundary");
    let (from, to) = layout(&fixture, source_root.as_deref());
    fs::create_dir_all(&from).unwrap();
    fs::create_dir_all(&to).unwrap();
    fs::write(from.join("item.txt"), PAYLOAD).unwrap();
    if overwriting(&boundary) {
        fs::write(to.join("item.txt"), DISPLACED).unwrap();
    }
    let coordinator = Coordinator::open(&fs::canonicalize(&fixture).unwrap().join("recovery"))
        .unwrap();
    let ready = fixture.join("mover-ready");
    let label: &'static str = Box::leak(boundary.clone().into_boxed_str());
    let stop = move |reached: &'static str| -> Result<(), AppError> {
        if reached != label {
            return Ok(());
        }
        fs::write(&ready, reached.as_bytes())?;
        loop {
            std::thread::park();
        }
    };
    let prepared =
        PreparedMove::prepare(&coordinator, &from.join("item.txt"), &to.join("item.txt")).unwrap();
    if boundary == "remove" {
        let receipt = prepared.execute(&mut Uninterrupted).unwrap();
        let history = receipt.relocation.unwrap().history;
        reopen(&coordinator, &history)
            .with_boundary(Box::new(stop))
            .remove_source()
            .unwrap();
        panic!("removal must stop before its completion checkpoint");
    }
    if boundary == "restore" {
        let receipt = prepared.execute(&mut Uninterrupted).unwrap();
        let history = receipt.relocation.unwrap().history;
        reopen(&coordinator, &history)
            .with_boundary(Box::new(stop))
            .restore_move()
            .unwrap();
        panic!("restoration must stop before its completion checkpoint");
    }
    prepared
        .execute_with(&mut Uninterrupted, Some(Box::new(stop)))
        .unwrap();
    panic!("move must stop before its completion checkpoint");
}

fn reopen(
    coordinator: &std::sync::Arc<Coordinator>,
    history: &crate::files::recovery::model::ReplacementHistory,
) -> MoveExecution {
    let operation = coordinator
        .try_claim_history(
            &history.id,
            history.revision,
            crate::files::recovery::coordinator::HistoryPosition::Published,
        )
        .unwrap()
        .expect("the completed record is claimable by its exact identity");
    MoveExecution::reopen(operation).unwrap()
}

fn run_to(boundary: &'static str) -> Option<(tempfile::TempDir, Option<tempfile::TempDir>)> {
    let shared = if cross_filesystem(boundary) {
        Some(shared_filesystem()?)
    } else {
        None
    };
    let fixture = tempfile::tempdir().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "files::recovery::move_execution::tests::subprocess_mover",
            "--ignored",
            "--nocapture",
        ])
        .env(FIXTURE, fixture.path())
        .env(BOUNDARY, boundary)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Some(shared) = &shared {
        command.env(SOURCE_ROOT, shared.path());
    }
    let mut child = command.spawn().unwrap();
    let ready = fixture.path().join("mover-ready");
    let deadline = Instant::now() + Duration::from_secs(30);
    while !ready.exists() {
        if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("mover did not reach the {boundary} boundary");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    // Kill between the native effect and its completion checkpoint.
    child.kill().unwrap();
    child.wait().unwrap();
    Some((fixture, shared))
}

/// Find the payload wherever it currently lives: at a public endpoint, or
/// retained inside a private artifact root.
fn reachable(directory: &Path, expected: &[u8]) -> bool {
    if !directory.is_dir() {
        return false;
    }
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if reachable(&path, expected) {
                return true;
            }
        } else if fs::read(&path).ok().as_deref() == Some(expected) {
            return true;
        }
    }
    false
}

#[test]
fn no_crash_boundary_can_leave_both_endpoints_absent() {
    for boundary in ["root", "manifest", "displace", "publish", "restore"] {
        let Some((fixture, shared)) = run_to(boundary) else {
            continue;
        };
        let (from, to) = layout(fixture.path(), shared.as_ref().map(tempfile::TempDir::path));
        assert!(
            reachable(&from, PAYLOAD) || reachable(&to, PAYLOAD),
            "the moved payload vanished at the {boundary} boundary"
        );
        if overwriting(boundary) {
            assert!(
                reachable(&to, DISPLACED),
                "the displaced original vanished at the {boundary} boundary"
            );
        }
        // Immutable catalog evidence survives every kill and stays claimable.
        let storage = fs::canonicalize(fixture.path()).unwrap().join("recovery");
        let intents = Coordinator::discover_catalog(&storage).unwrap();
        assert_eq!(intents.len(), 1, "{boundary} lost its catalog evidence");
        assert!(Coordinator::open(&storage).is_ok());
    }
}

#[test]
fn cross_filesystem_crash_boundaries_never_strand_the_only_copy() {
    for boundary in ["stage", "park", "remove"] {
        let Some((fixture, shared)) = run_to(boundary) else {
            continue;
        };
        let (from, to) = layout(fixture.path(), shared.as_ref().map(tempfile::TempDir::path));
        assert!(
            reachable(&from, PAYLOAD) || reachable(&to, PAYLOAD),
            "the moved payload vanished at the {boundary} boundary"
        );
        if boundary == "park" {
            // Parking follows publication, so the destination already holds it.
            assert_eq!(fs::read(to.join("item.txt")).unwrap(), PAYLOAD);
        }
        if boundary == "stage" {
            // Nothing public has changed while a copy is still being staged.
            assert_eq!(fs::read(from.join("item.txt")).unwrap(), PAYLOAD);
            assert!(!to.join("item.txt").exists());
        }
        let storage = fs::canonicalize(fixture.path()).unwrap().join("recovery");
        assert_eq!(Coordinator::discover_catalog(&storage).unwrap().len(), 1);
    }
}
