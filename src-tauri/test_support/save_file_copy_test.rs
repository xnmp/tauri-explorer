//! `save_file_copy` contracts (#1588), black-box through the real command:
//! no spelling of the source can be the destination, nothing blocks on a
//! special file, and every other outcome is the plain `fs::copy` behaviour.
use crate::error::AppError;
use crate::files::video_info::save_file_copy;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

fn mk(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into()
}

/// Runs the real command on its own thread and bounds the wait: a call that
/// blocks (FIFO open) cannot be cancelled, so the thread is left detached.
fn save_within(src: &Path, dst: &Path, limit: Duration) -> Option<Result<(), AppError>> {
    let (tx, rx) = mpsc::channel();
    let (a, b) = (s(src), s(dst));
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _ = tx.send(rt.block_on(save_file_copy(a, b)));
        rt.shutdown_background();
    });
    rx.recv_timeout(limit).ok()
}

fn save(src: &Path, dst: &Path) -> Result<(), AppError> {
    save_within(src, dst, Duration::from_secs(30)).expect("save_file_copy did not return")
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

fn refused(r: &Result<(), AppError>) -> bool {
    matches!(r, Err(AppError::InvalidPath(m)) if m == "Choose a different destination")
}

/// Written straight to the process's stderr, which libtest does not capture,
/// so a skipped precondition is visible in every run.
#[cfg(unix)]
fn skip(test: &str, reason: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "SKIPPED {test}: {reason}");
}

#[cfg(unix)]
fn chmod(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[cfg(unix)]
fn mkfifo(p: &Path) {
    assert!(std::process::Command::new("mkfifo")
        .arg(p)
        .status()
        .unwrap()
        .success());
}

#[test]
fn issue_1588_alias_matrix_is_refused_and_source_bytes_survive() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path();
    let bytes = b"precious video bytes";
    let src = mk(dir, "a.mkv", bytes);
    let mut aliases = vec![("hardlink", dir.join("hard.mkv"))];
    std::fs::hard_link(&src, &aliases[0].1).unwrap();
    let base = dir.file_name().unwrap().to_str().unwrap();
    aliases.push((
        "dot-dot",
        PathBuf::from(format!("{}/../{base}/a.mkv", dir.display())),
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        symlink(&src, dir.join("link.mkv")).unwrap();
        symlink(dir.join("link.mkv"), dir.join("chain.mkv")).unwrap();
        symlink(dir, dir.join("parent")).unwrap();
        aliases.push(("symlink", dir.join("link.mkv")));
        aliases.push(("chain", dir.join("chain.mkv")));
        aliases.push(("symlinked parent", dir.join("parent").join("a.mkv")));
    }
    // A magic link to an open descriptor of the source.
    #[cfg(target_os = "linux")]
    let _held = {
        use std::os::fd::AsRawFd;
        let held = std::fs::File::open(&src).unwrap();
        let fd = PathBuf::from(format!("/proc/self/fd/{}", held.as_raw_fd()));
        aliases.push(("/proc/self/fd", fd));
        held
    };
    for (label, alias) in &aliases {
        let r = save(&src, alias);
        assert!(refused(&r), "{label}: {r:?}");
        assert_eq!(std::fs::read(&src).unwrap(), bytes, "{label}");
    }
    #[cfg(unix)]
    {
        let r = save(&dir.join("link.mkv"), &src);
        assert!(refused(&r), "source is a symlink to the destination: {r:?}");
        assert_eq!(std::fs::read(&src).unwrap(), bytes);
    }
}

/// Opening a FIFO blocks until a peer appears. Source and destination are
/// both judged from metadata, so neither is ever opened.
#[cfg(unix)]
#[test]
fn issue_1588_fifo_source_is_refused_promptly() {
    let root = tempfile::tempdir().unwrap();
    let fifo = root.path().join("pipe");
    mkfifo(&fifo);
    let existing = mk(root.path(), "b.mkv", b"keep me");
    for dst in [existing.clone(), root.path().join("new.mkv")] {
        let r = save_within(&fifo, &dst, Duration::from_secs(5))
            .unwrap_or_else(|| panic!("blocked on a FIFO source ({})", dst.display()));
        assert!(
            matches!(&r, Err(AppError::InvalidPath(m)) if m.contains("not a regular file")),
            "{r:?}"
        );
    }
    assert_eq!(std::fs::read(&existing).unwrap(), b"keep me");
    assert_eq!(names(root.path()), ["b.mkv", "pipe"]);
}

#[cfg(unix)]
#[test]
fn issue_1588_fifo_destination_is_refused_without_blocking() {
    let root = tempfile::tempdir().unwrap();
    let src = mk(root.path(), "a.mkv", b"new");
    let fifo = root.path().join("pipe");
    mkfifo(&fifo);
    let r = save_within(&src, &fifo, Duration::from_secs(5)).expect("blocked on a FIFO");
    assert!(
        matches!(&r, Err(AppError::InvalidPath(m)) if m.contains("not a regular file")),
        "{r:?}"
    );
}

#[test]
fn issue_1588_directory_destination_is_a_clear_error_and_untouched() {
    let root = tempfile::tempdir().unwrap();
    let src = mk(root.path(), "a.mkv", b"new");
    let d = root.path().join("dir");
    std::fs::create_dir(&d).unwrap();
    let r = save(&src, &d);
    assert!(
        matches!(&r, Err(AppError::InvalidPath(m)) if m.contains("folder")),
        "{r:?}"
    );
    assert!(names(&d).is_empty());
}

#[test]
fn issue_1588_missing_source_with_directory_destination_is_not_found() {
    let root = tempfile::tempdir().unwrap();
    let d = root.path().join("dir");
    std::fs::create_dir(&d).unwrap();
    let r = save(&root.path().join("missing.mkv"), &d);
    assert!(matches!(r, Err(AppError::NotFound(_))), "{r:?}");
    assert!(d.is_dir());
}

// ---- Old-behaviour pins: identical on the pre-#1588 code and now. ----

#[test]
fn issue_1588_pin_overwrites_a_different_existing_file() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path();
    let src = mk(dir, "a.mkv", b"new");
    let dst = mk(dir, "b.mkv", b"old contents, longer");
    save(&src, &dst).unwrap();
    assert_eq!(std::fs::read(&dst).unwrap(), b"new");
    assert_eq!(std::fs::read(&src).unwrap(), b"new");
    assert_eq!(names(dir), ["a.mkv", "b.mkv"]);
}

#[test]
fn issue_1588_pin_missing_source_is_not_found_and_destination_untouched() {
    let root = tempfile::tempdir().unwrap();
    let dst = mk(root.path(), "b.mkv", b"keep me");
    let r = save(&root.path().join("missing.mkv"), &dst);
    assert!(matches!(r, Err(AppError::NotFound(_))), "{r:?}");
    assert_eq!(std::fs::read(&dst).unwrap(), b"keep me");
}

/// The overwrite keeps the inode, so hard-link peers keep sharing content.
#[test]
fn issue_1588_pin_hard_link_peer_still_shares_content_after_save() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path();
    let src = mk(dir, "a.mkv", b"new bytes");
    let dst = mk(dir, "b.mkv", b"old");
    let peer = dir.join("peer.mkv");
    std::fs::hard_link(&dst, &peer).unwrap();
    save(&src, &dst).unwrap();
    assert_eq!(std::fs::read(&dst).unwrap(), b"new bytes");
    assert_eq!(std::fs::read(&peer).unwrap(), b"new bytes");
    assert_eq!(names(dir), ["a.mkv", "b.mkv", "peer.mkv"]);
}

/// A writable file in a directory we cannot write is overwritten in place.
/// (Root ignores permission bits; the outcome is the same either way.)
#[cfg(unix)]
#[test]
fn issue_1588_pin_writable_file_in_read_only_directory_is_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let src = mk(root.path(), "a.mkv", b"new bytes");
    let ro = root.path().join("ro");
    std::fs::create_dir(&ro).unwrap();
    let dst = mk(&ro, "b.mkv", b"old contents, longer");
    chmod(&dst, 0o666);
    chmod(&ro, 0o555);
    let r = save(&src, &dst);
    let after = std::fs::read(&dst).unwrap();
    let left = names(&ro);
    chmod(&ro, 0o755);
    r.unwrap();
    assert_eq!(after, b"new bytes");
    assert_eq!(left, ["b.mkv"]);
}

#[cfg(unix)]
#[test]
fn issue_1588_pin_read_only_destination_is_refused_and_untouched() {
    let root = tempfile::tempdir().unwrap();
    let src = mk(root.path(), "a.mkv", b"new");
    let dst = mk(root.path(), "b.mkv", b"old");
    chmod(&dst, 0o444);
    if std::fs::OpenOptions::new().write(true).open(&dst).is_ok() {
        skip(
            "issue_1588_pin_read_only_destination_is_refused_and_untouched",
            "permission bits do not bind this user (root)",
        );
        return;
    }
    let r = save(&src, &dst);
    assert!(matches!(r, Err(AppError::PermissionDenied(_))), "{r:?}");
    assert_eq!(std::fs::read(&dst).unwrap(), b"old");
}

#[cfg(unix)]
#[test]
fn issue_1588_pin_symlink_destination_keeps_link_and_updates_target() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path();
    let src = mk(dir, "a.mkv", b"new");
    let real = mk(dir, "real.mkv", b"old");
    let mid = dir.join("mid.mkv");
    let link = dir.join("link.mkv");
    std::os::unix::fs::symlink(&real, &mid).unwrap();
    std::os::unix::fs::symlink(&mid, &link).unwrap();
    save(&src, &link).unwrap();
    for l in [&link, &mid] {
        assert!(std::fs::symlink_metadata(l)
            .unwrap()
            .file_type()
            .is_symlink());
    }
    assert_eq!(std::fs::read(&real).unwrap(), b"new");
}

#[cfg(unix)]
#[test]
fn issue_1588_pin_dangling_symlink_destination_creates_its_target() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path();
    let src = mk(dir, "a.mkv", b"new");
    let link = dir.join("link.mkv");
    std::os::unix::fs::symlink(dir.join("made.mkv"), &link).unwrap();
    save(&src, &link).unwrap();
    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(dir.join("made.mkv")).unwrap(), b"new");
}

/// Linux `fs::copy` gives the destination the source's permission bits, for
/// a new file and when overwriting an existing one.
#[cfg(target_os = "linux")]
#[test]
fn issue_1588_pin_destination_takes_the_source_permission_bits() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let src = mk(root.path(), "a.mkv", b"new");
    let dst = mk(root.path(), "b.mkv", b"old");
    chmod(&src, 0o600);
    chmod(&dst, 0o644);
    save(&src, &dst).unwrap();
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o7777;
    assert_eq!(mode(&dst), 0o600);
    let fresh = root.path().join("c.mkv");
    save(&src, &fresh).unwrap();
    assert_eq!(mode(&fresh), 0o600);
}
