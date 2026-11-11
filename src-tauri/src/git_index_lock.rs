//! Index updates that hold `index.lock` from read to write (#1617).
//!
//! `git2::Index::write` takes `index.lock` only while it writes. An update
//! that reads the index, plans and then writes therefore overwrote anything
//! another git process committed in between: a `git add` that exited 0 during
//! a long unstage was silently lost. Every libgit2 index writer in the app
//! goes through [`with_locked_index_hooked`] instead, which follows git's own lock
//! protocol for the whole update:
//!
//! 1. create `<gitdir>/index.lock` exclusively (a concurrent git command now
//!    fails with "index.lock exists" rather than racing us);
//! 2. copy the index's bytes to a new private file in the same directory, keeping its
//!    modification time (libgit2 compares entries against it to smudge racily
//!    clean entries), and open that copy;
//! 3. let the caller read and change it, write it with libgit2 (to the
//!    private file), then rename it over `index.lock` and `index.lock` over
//!    `index` — exactly how git commits a locked index.
//!
//! `<gitdir>` is `Repository::path()`, so a linked worktree locks its own
//! index. In-app updates of one gitdir also queue on an in-process turn, so
//! two clicks never collide on the lock file and blame "another process". On any failure the private file and the lock are removed and the
//! index is left as it was.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, MutexGuard};

use git2::{Index, Repository};

use crate::error::AppError;
use crate::git_common::to_app_err;

/// How lookups in the opened index treat case.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum IndexCase {
    /// Exact-case lookups whatever `core.ignorecase` says: literal unstage
    /// and discard. `Repository::index()` inherits `core.ignorecase`, and
    /// libgit2 then finds, removes and replaces entries without regard to
    /// case, so working on `A` silently touched a tracked `a` (#1589 review);
    /// git matches literal paths case-sensitively. An index opened by path
    /// has no ignore-case capability; `write` still sorts it as git expects.
    Exact,
    /// The repository's own capabilities, as `Repository::index()` would
    /// give: staging, which has always followed `core.ignorecase`.
    Repository,
}

/// Whether the caller's update must be written.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum IndexUpdate {
    Write,
    Unchanged,
}

static PRIVATE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Files this update owns; removed on drop unless committed.
struct Held {
    lock: PathBuf,
    private: PathBuf,
    private_lock: PathBuf,
    committed: bool,
}

impl Drop for Held {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.private_lock);
        let _ = fs::remove_file(&self.private);
        if !self.committed {
            let _ = fs::remove_file(&self.lock);
        }
    }
}

fn locked_error(lock: &Path) -> AppError {
    AppError::Other(format!(
        "another git process holds the index ({}); nothing was changed. \
         Retry when it finishes, or remove a stale lock.",
        lock.display()
    ))
}

/// Give `index`, opened by path, the capabilities its owner repository would
/// give its own index (`GIT_INDEX_CAPABILITY_FROM_OWNER`); git2 does not bind
/// `git_index_set_caps`.
fn use_repository_caps(index: &mut Index) -> Result<(), AppError> {
    use git2::Binding;
    extern "C" {
        fn git_index_set_caps(
            index: *mut std::ffi::c_void,
            caps: std::ffi::c_int,
        ) -> std::ffi::c_int;
    }
    const GIT_INDEX_CAPABILITY_FROM_OWNER: std::ffi::c_int = -1;
    // SAFETY: `index.raw()` is a live `git_index *` owned by `index` for the
    // duration of the call; libgit2 only reads its owner's configuration.
    let rc = unsafe { git_index_set_caps(index.raw().cast(), GIT_INDEX_CAPABILITY_FROM_OWNER) };
    if rc < 0 {
        return Err(to_app_err(git2::Error::last_error(rc)));
    }
    Ok(())
}

/// [`with_locked_index_hooked`] without a hook (tests).
#[cfg(test)]
pub(crate) fn with_locked_index<T>(
    repo: &Repository,
    case: IndexCase,
    update: impl FnOnce(&mut Index) -> Result<(T, IndexUpdate), AppError>,
) -> Result<T, AppError> {
    with_locked_index_hooked(repo, case, update, || {})
}

/// Run `update` on the repository's index while holding `index.lock` from
/// before the read until the new index is in place. `update` returns whether
/// to write; [`IndexUpdate::Unchanged`] (or an error) leaves the index file
/// untouched. `before_write` runs after `update` and before the write: tests
/// run a concurrent git command there.
///
/// The opened index is installed as `repo`'s index (`Repository::set_index`),
/// so checkout and racily-clean smudging see it. On return, success or not,
/// the handle gets the repository's own index back, read afresh, so later
/// use of `repo` (a status, say) sees what is on disk.
pub(crate) fn with_locked_index_hooked<T>(
    repo: &Repository,
    case: IndexCase,
    update: impl FnOnce(&mut Index) -> Result<(T, IndexUpdate), AppError>,
    before_write: impl FnOnce(),
) -> Result<T, AppError> {
    with_locked_index_mapped(repo, case, update, before_write, |_, e| e, |_| Ok(()))
}

/// [`with_locked_index_hooked`] with two more steps, both for discard, whose
/// work-tree effects have already happened by then:
///
/// - `commit_error` describes a failure to write or install the updated
///   index after `update` succeeded;
/// - `after_release` runs once the new index is in place (or was left
///   unchanged) and `index.lock` is gone, but while this process still holds
///   its turn for the gitdir. A git CLI command that takes `index.lock`
///   itself runs there: it then reads the index this update committed, and no
///   other in-app writer can take the lock first (#1616, #1617).
pub(crate) fn with_locked_index_mapped<T>(
    repo: &Repository,
    case: IndexCase,
    update: impl FnOnce(&mut Index) -> Result<(T, IndexUpdate), AppError>,
    before_write: impl FnOnce(),
    commit_error: impl FnOnce(&T, AppError) -> AppError,
    after_release: impl FnOnce(&T) -> Result<(), AppError>,
) -> Result<T, AppError> {
    let gitdir = repo.path();
    // In-app writers of one index queue here instead of colliding on
    // `index.lock` and blaming "another git process" (#1617 review).
    // Declared before `held`, so it is dropped after it: our lock file is
    // gone before the next in-app writer takes its turn.
    let _turn = GitdirTurn::take(gitdir);
    let index_path = gitdir.join("index");
    // Declared before `held`, so it runs once the lock and copy are gone.
    let _restore = RestoreRepoIndex {
        repo,
        index_path: &index_path,
    };
    let lock = gitdir.join("index.lock");
    // Close the handle at once: the lock is the file's existence, and Windows
    // cannot rename over a file that is still open.
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
    {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Err(locked_error(&lock)),
        Err(e) => return Err(e.into()),
    }
    let private = gitdir.join(format!(
        "index.tauri-explorer-{}-{}",
        std::process::id(),
        PRIVATE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    // libgit2 writes the copy through `<copy>.lock`.
    let mut private_lock = private.clone().into_os_string();
    private_lock.push(".lock");
    let mut held = Held {
        lock,
        private,
        private_lock: PathBuf::from(private_lock),
        committed: false,
    };

    match fs::metadata(&index_path) {
        Ok(meta) => {
            // A new file rather than `fs::copy`, which would carry over a
            // read-only mode and then refuse the write handle that sets the
            // mtime. libgit2 rewrites the index with its own mode anyway.
            let bytes = fs::read(&index_path)?;
            let mut copy = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&held.private)?;
            copy.write_all(&bytes)?;
            copy.set_modified(meta.modified()?)?;
        }
        // An unborn repository may have no index yet: start from empty.
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }

    let mut index = Index::open(&held.private).map_err(to_app_err)?;
    // Owned by the repository, libgit2 smudges racily clean entries when it
    // writes, and checkout uses this index rather than reloading `index`.
    repo.set_index(&mut index).map_err(to_app_err)?;
    if case == IndexCase::Repository {
        use_repository_caps(&mut index)?;
    }
    let (out, write) = update(&mut index)?;
    if write == IndexUpdate::Write {
        before_write();
        let committed = index
            .write()
            .map_err(to_app_err)
            .and_then(|()| rename_retrying(&held.private, &held.lock))
            .and_then(|()| rename_retrying(&held.lock, &index_path));
        if let Err(e) = committed {
            return Err(commit_error(&out, e));
        }
        held.committed = true;
    }
    // Release `index.lock` (renamed into place, or removed) and the private
    // copy, keeping the in-process turn.
    drop(held);
    after_release(&out)?;
    Ok(out)
}

/// Gives `repo` back its own index when an update ends: the installed copy
/// is consumed (or discarded), and a later reader of the handle would
/// otherwise see that stale copy instead of the index on disk.
struct RestoreRepoIndex<'a> {
    repo: &'a Repository,
    index_path: &'a Path,
}

impl Drop for RestoreRepoIndex<'_> {
    fn drop(&mut self) {
        // Best effort: on failure the handle keeps the copy, as before.
        if let Ok(mut index) = Index::open(self.index_path) {
            if self.repo.set_index(&mut index).is_ok() {
                let _ = use_repository_caps(&mut index);
            }
        }
    }
}

/// `fs::rename`, retried briefly on Windows while another process (an
/// editor, indexer or git itself reading the index) has the destination open
/// without delete sharing, as libgit2's `p_rename` does (#1617 review).
fn rename_retrying(from: &Path, to: &Path) -> Result<(), AppError> {
    const ATTEMPTS: u32 = if cfg!(windows) { 10 } else { 1 };
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < ATTEMPTS && is_sharing_error(&e) => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(5 * u64::from(attempt)));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

/// ERROR_ACCESS_DENIED (5), ERROR_SHARING_VIOLATION (32) or
/// ERROR_LOCK_VIOLATION (33). Only consulted on Windows.
fn is_sharing_error(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

/// One in-app index update at a time per gitdir (keyed canonically, so two
/// spellings of one repository share a turn). A turn is a flag and condvar,
/// not a held `MutexGuard`, so it is released even if the update panics.
struct GitdirTurn {
    key: PathBuf,
    slot: Arc<Slot>,
}

#[derive(Default)]
struct Slot {
    state: Mutex<SlotState>,
    free: Condvar,
}

#[derive(Default)]
struct SlotState {
    busy: bool,
    waiters: usize,
}

static TURNS: LazyLock<Mutex<HashMap<PathBuf, Arc<Slot>>>> = LazyLock::new(Default::default);

fn lock_ignoring_poison<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl GitdirTurn {
    fn key(gitdir: &Path) -> PathBuf {
        fs::canonicalize(gitdir).unwrap_or_else(|_| gitdir.to_path_buf())
    }

    fn take(gitdir: &Path) -> Self {
        let key = Self::key(gitdir);
        let slot = lock_ignoring_poison(&TURNS)
            .entry(key.clone())
            .or_default()
            .clone();
        let mut state = lock_ignoring_poison(&slot.state);
        state.waiters += 1;
        while state.busy {
            state = slot.free.wait(state).unwrap_or_else(|p| p.into_inner());
        }
        state.waiters -= 1;
        state.busy = true;
        drop(state);
        GitdirTurn { key, slot }
    }

    /// In-app updates of `gitdir` waiting for their turn (tests).
    #[cfg(test)]
    fn waiting(gitdir: &Path) -> usize {
        let key = Self::key(gitdir);
        let slot = lock_ignoring_poison(&TURNS).get(&key).cloned();
        slot.map_or(0, |s| lock_ignoring_poison(&s.state).waiters)
    }
}

impl Drop for GitdirTurn {
    fn drop(&mut self) {
        let mut turns = lock_ignoring_poison(&TURNS);
        lock_ignoring_poison(&self.slot.state).busy = false;
        self.slot.free.notify_one();
        // Forget an idle repository: only the map and this turn hold it, and
        // every clone is taken or dropped under the map lock.
        if Arc::strong_count(&self.slot) == 2 {
            turns.remove(&self.key);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::Path;
    use std::process::Command;

    use git2::Repository;
    use tempfile::TempDir;

    use super::{with_locked_index, with_locked_index_hooked, IndexCase, IndexUpdate};

    /// No lock and no private index copy remain in `gitdir`.
    pub(crate) fn assert_no_leftovers(gitdir: &Path) {
        let names: Vec<String> = std::fs::read_dir(gitdir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".lock") || n.starts_with("index.tauri-explorer"))
            .collect();
        assert!(names.is_empty(), "left in {gitdir:?}: {names:?}");
    }

    fn git(dir: &Path, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
            .args(args)
            .output()
            .unwrap()
    }

    fn ok(dir: &Path, args: &[&str]) -> String {
        let out = git(dir, args);
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn repo() -> TempDir {
        let d = TempDir::new().unwrap();
        ok(d.path(), &["init", "-q", "-b", "main"]);
        ok(d.path(), &["config", "core.autocrlf", "false"]);
        std::fs::write(d.path().join("a"), "a\n").unwrap();
        ok(d.path(), &["add", "a"]);
        ok(d.path(), &["commit", "-q", "-m", "c"]);
        d
    }

    #[test]
    fn a_held_lock_is_refused_before_reading_and_left_in_place() {
        let d = repo();
        let lock = d.path().join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let repo = Repository::open(d.path()).unwrap();
        let mut ran = false;
        let err = with_locked_index(&repo, IndexCase::Exact, |_| {
            ran = true;
            Ok(((), IndexUpdate::Write))
        })
        .unwrap_err();
        assert!(!ran);
        assert!(format!("{err:?}").contains("index.lock"), "{err:?}");
        assert!(lock.exists(), "a foreign lock must never be removed");
    }

    #[test]
    fn a_failed_or_unchanged_update_releases_the_lock_and_keeps_the_index() {
        let d = repo();
        let before = std::fs::read(d.path().join(".git/index")).unwrap();
        let repo = Repository::open(d.path()).unwrap();
        with_locked_index(&repo, IndexCase::Exact, |index| {
            index.remove_path(Path::new("a")).unwrap();
            Ok(((), IndexUpdate::Unchanged))
        })
        .unwrap();
        let repo = Repository::open(d.path()).unwrap();
        let _ = with_locked_index::<()>(&repo, IndexCase::Exact, |index| {
            index.remove_path(Path::new("a")).unwrap();
            Err(crate::error::AppError::Other("planned failure".into()))
        })
        .unwrap_err();
        assert_eq!(std::fs::read(d.path().join(".git/index")).unwrap(), before);
        assert_no_leftovers(&d.path().join(".git"));
    }

    /// Two in-app updates of one index queue rather than the second failing
    /// on our own `index.lock` (#1617 review): the second starts only after
    /// it is observed waiting, and both changes land.
    #[test]
    fn concurrent_in_app_updates_of_one_index_queue_and_both_land() {
        let d = repo();
        std::fs::write(d.path().join("b"), "b\n").unwrap();
        std::fs::write(d.path().join("c"), "c\n").unwrap();
        let gitdir = d.path().join(".git");
        let path = d.path().to_path_buf();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let second_finished = finished.clone();
        let second = std::thread::spawn(move || {
            started_rx.recv().unwrap();
            let repo = Repository::open(&path).unwrap();
            let result = with_locked_index(&repo, IndexCase::Exact, |index| {
                index.add_path(Path::new("c")).unwrap();
                Ok(((), IndexUpdate::Write))
            });
            second_finished.store(true, std::sync::atomic::Ordering::SeqCst);
            result
        });
        let repo = Repository::open(d.path()).unwrap();
        with_locked_index_hooked(
            &repo,
            IndexCase::Exact,
            |index| {
                index.add_path(Path::new("b")).unwrap();
                Ok(((), IndexUpdate::Write))
            },
            || {
                started_tx.send(()).unwrap();
                // Hold our turn until the second update is queued behind it
                // (or, without the queue, has already failed on our lock).
                while super::GitdirTurn::waiting(&gitdir) == 0
                    && !finished.load(std::sync::atomic::Ordering::SeqCst)
                {
                    std::thread::yield_now();
                }
            },
        )
        .unwrap();
        second.join().unwrap().unwrap();
        let tracked = ok(d.path(), &["ls-files"]);
        for name in ["a", "b", "c"] {
            assert!(
                tracked.lines().any(|l| l == name),
                "{name} missing:\n{tracked}"
            );
        }
        assert_no_leftovers(&gitdir);
    }

    /// A read-only index file (some tools leave 0444) is still updated.
    #[cfg(unix)]
    #[test]
    fn a_read_only_index_file_is_still_updated() {
        use std::os::unix::fs::PermissionsExt;
        let d = repo();
        std::fs::write(d.path().join("b"), "b\n").unwrap();
        let index_path = d.path().join(".git/index");
        std::fs::set_permissions(&index_path, std::fs::Permissions::from_mode(0o444)).unwrap();
        let repo = Repository::open(d.path()).unwrap();
        with_locked_index(&repo, IndexCase::Exact, |index| {
            index.add_path(Path::new("b")).unwrap();
            Ok(((), IndexUpdate::Write))
        })
        .unwrap();
        assert!(ok(d.path(), &["ls-files"]).lines().any(|l| l == "b"));
        assert_no_leftovers(&d.path().join(".git"));
    }

    /// A failure to install the written index goes through `commit_error`
    /// with the update's result, and releases the lock.
    #[test]
    fn a_failed_commit_is_described_by_the_caller_and_releases_the_lock() {
        let d = repo();
        let index_path = d.path().join(".git/index");
        let repo = Repository::open(d.path()).unwrap();
        let err = super::with_locked_index_mapped(
            &repo,
            IndexCase::Exact,
            |_| Ok((7, IndexUpdate::Write)),
            // A non-empty directory cannot be replaced by a rename.
            || {
                std::fs::remove_file(&index_path).unwrap();
                std::fs::create_dir(&index_path).unwrap();
                std::fs::write(index_path.join("x"), "").unwrap();
            },
            |out, e| crate::error::AppError::Other(format!("after {out}: {e:?}")),
            |_| panic!("runs only after a successful update"),
        )
        .unwrap_err();
        assert!(format!("{err:?}").contains("after 7"), "{err:?}");
        assert_no_leftovers(&d.path().join(".git"));
    }

    /// `after_release` runs with `index.lock` released, so a git command
    /// that takes it succeeds and sees the committed index, whether the
    /// update wrote or left the index unchanged.
    #[test]
    fn after_release_runs_unlocked_after_the_commit() {
        for write in [IndexUpdate::Write, IndexUpdate::Unchanged] {
            let d = repo();
            std::fs::write(d.path().join("b"), "b\n").unwrap();
            std::fs::write(d.path().join("c"), "c\n").unwrap();
            let repo = Repository::open(d.path()).unwrap();
            super::with_locked_index_mapped(
                &repo,
                IndexCase::Exact,
                |index| {
                    index.add_path(Path::new("b")).unwrap();
                    Ok(((), write))
                },
                || {},
                |_, e| e,
                |_| {
                    ok(d.path(), &["add", "c"]);
                    Ok(())
                },
            )
            .unwrap();
            let tracked = ok(d.path(), &["ls-files"]);
            assert_eq!(
                tracked.lines().any(|l| l == "b"),
                write == IndexUpdate::Write,
                "{tracked}"
            );
            assert!(tracked.lines().any(|l| l == "c"), "{tracked}");
            assert_no_leftovers(&d.path().join(".git"));
        }
    }

    /// After an update the handle reads the index on disk again, with the
    /// repository's own case handling, not the consumed private copy.
    #[test]
    fn the_handle_gets_the_repository_index_back() {
        let d = repo();
        ok(d.path(), &["config", "core.ignorecase", "true"]);
        std::fs::write(d.path().join("b"), "b\n").unwrap();
        std::fs::write(d.path().join("c"), "c\n").unwrap();
        let repo = Repository::open(d.path()).unwrap();
        with_locked_index(&repo, IndexCase::Exact, |index| {
            index.add_path(Path::new("b")).unwrap();
            Ok(((), IndexUpdate::Write))
        })
        .unwrap();
        ok(d.path(), &["add", "c"]);
        let index = repo.index().unwrap();
        assert_eq!(index.path(), Some(d.path().join(".git/index").as_path()));
        let mut index = index;
        index.read(false).unwrap();
        assert!(index.get_path(Path::new("b"), 0).is_some());
        assert!(index.get_path(Path::new("c"), 0).is_some());
        assert!(
            index.get_path(Path::new("A"), 0).is_some(),
            "ignorecase lost"
        );
    }

    /// Staging keeps `core.ignorecase` lookups (`Repository::index()`
    /// semantics); unstage and discard stay exact-case.
    #[test]
    fn the_case_mode_follows_the_request() {
        let d = repo();
        ok(d.path(), &["config", "core.ignorecase", "true"]);
        let found = |case| {
            let repo = Repository::open(d.path()).unwrap();
            with_locked_index(&repo, case, |index| {
                Ok((
                    index.get_path(Path::new("A"), 0).is_some(),
                    IndexUpdate::Unchanged,
                ))
            })
            .unwrap()
        };
        assert!(found(IndexCase::Repository));
        assert!(!found(IndexCase::Exact));
        assert_no_leftovers(&d.path().join(".git"));
    }

    /// A linked worktree has its own index under `.git/worktrees/<name>`;
    /// the update locks and replaces that one, never the main index.
    #[test]
    fn a_linked_worktree_locks_and_writes_its_own_index() {
        let d = repo();
        let wt_parent = TempDir::new().unwrap();
        let wt = wt_parent.path().join("wt");
        ok(d.path(), &["worktree", "add", "-q", wt.to_str().unwrap()]);
        std::fs::write(wt.join("b"), "b\n").unwrap();
        let main_index = std::fs::read(d.path().join(".git/index")).unwrap();
        let repo = Repository::open(&wt).unwrap();
        let mut concurrent = None;
        with_locked_index_hooked(
            &repo,
            IndexCase::Repository,
            |index| {
                index.add_path(Path::new("b")).unwrap();
                Ok(((), IndexUpdate::Write))
            },
            || concurrent = Some(git(&wt, &["add", "b"])),
        )
        .unwrap();
        let concurrent = concurrent.unwrap();
        assert!(!concurrent.status.success(), "{concurrent:?}");
        assert!(ok(&wt, &["ls-files"]).lines().any(|l| l == "b"));
        assert_eq!(
            std::fs::read(d.path().join(".git/index")).unwrap(),
            main_index
        );
        assert_no_leftovers(repo.path());
    }
}
