//! Literal index reset for the SCM "Unstage" action (#1589).
//!
//! `git2::Repository::reset_default` parses its paths as pathspecs, so
//! unstaging a file named `f[1].txt` also unstaged `f1.txt`. This module does
//! what `git --literal-pathspecs reset -q HEAD -- <paths>` does to the index,
//! with each path matched literally (the path itself, or anything below it):
//!
//! - Only entries that differ from the tree (mode, id, or a conflict) are
//!   rewritten. Unchanged entries keep their stat data and their
//!   skip-worktree / assume-unchanged bits, as with git.
//! - A rewritten entry keeps `skip-worktree` (git's `reset` does too) and has
//!   zeroed stat data (git's `make_cache_entry`; the next status refreshes it).
//! - Only blobs, symlinks and gitlinks are written. A tree in the target tree
//!   is expanded into its leaves, so a directory replaced by a file (or the
//!   reverse) resets to the tree's shape.
//! - Cost is O(paths · log n + affected entries): each path is located in the
//!   sorted index by binary search and in the tree by lookup, never by a scan
//!   of the whole index.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::path::Path;

use git2::{IndexEntry, IndexEntryExtendedFlag, IndexTime, ObjectType, Oid, Repository, Tree};

use crate::error::AppError;
use crate::git_common::{exact_case_index, literal_repo_path, to_app_err, LiteralRepoPath};

const GITLINK_MODE: u32 = 0o160000;

/// A blob, symlink or gitlink as git stores it in the index.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct Leaf {
    mode: u32,
    id: Oid,
}

/// Index paths are bytes; on Unix they need not be UTF-8.
#[cfg(unix)]
fn index_path(bytes: &[u8]) -> Result<&Path, AppError> {
    use std::os::unix::ffi::OsStrExt;
    Ok(Path::new(std::ffi::OsStr::from_bytes(bytes)))
}

#[cfg(not(unix))]
fn index_path(bytes: &[u8]) -> Result<&Path, AppError> {
    std::str::from_utf8(bytes)
        .map(Path::new)
        .map_err(|_| AppError::Other("git: index path is not valid UTF-8".into()))
}

/// git's `canon_mode`: legacy `100664`-style tree modes become `100644`, which
/// is also the only regular-file spelling `git_index_add` accepts.
fn canonical_mode(mode: u32) -> Option<u32> {
    match mode & 0o170000 {
        0o100000 if mode & 0o111 != 0 => Some(0o100755),
        0o100000 => Some(0o100644),
        0o120000 => Some(0o120000),
        GITLINK_MODE => Some(GITLINK_MODE),
        _ => None,
    }
}

fn leaf_of(entry: &git2::TreeEntry<'_>) -> Option<Leaf> {
    match entry.kind() {
        Some(ObjectType::Blob) | Some(ObjectType::Commit) => {
            canonical_mode(entry.filemode() as u32).map(|mode| Leaf {
                mode,
                id: entry.id(),
            })
        }
        _ => None,
    }
}

/// Every leaf of `tree` at or below `target` (only below, for a `dir_only`
/// target), keyed by its `/`-separated index path (built from raw name bytes,
/// never through a platform `Path`).
fn tree_leaves_under(
    repo: &Repository,
    tree: &Tree<'_>,
    LiteralRepoPath {
        path: target,
        dir_only,
    }: LiteralRepoPath<'_>,
    out: &mut BTreeMap<Vec<u8>, Leaf>,
) -> Result<(), AppError> {
    let entry = match tree.get_path(Path::new(target)) {
        Ok(entry) => entry,
        Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(()),
        Err(e) => return Err(to_app_err(e)),
    };
    if let Some(leaf) = leaf_of(&entry) {
        // git's pathspecs treat a gitlink as a directory.
        if !dir_only || leaf.mode == GITLINK_MODE {
            out.insert(target.as_bytes().to_vec(), leaf);
        }
        return Ok(());
    }
    if entry.kind() != Some(ObjectType::Tree) {
        return Ok(());
    }
    let mut stack = vec![(target.as_bytes().to_vec(), entry.id())];
    while let Some((prefix, id)) = stack.pop() {
        let subtree = repo.find_tree(id).map_err(to_app_err)?;
        for child in subtree.iter() {
            let mut path = prefix.clone();
            path.push(b'/');
            path.extend_from_slice(child.name_bytes());
            if child.kind() == Some(ObjectType::Tree) {
                stack.push((path, child.id()));
            } else if let Some(leaf) = leaf_of(&child) {
                out.insert(path, leaf);
            }
        }
    }
    Ok(())
}

/// Every index path (any stage) equal to `target` (unless `dir_only`) or below
/// `target/`. The index is sorted, so the descendants are one contiguous run.
fn index_paths_under(
    index: &git2::Index,
    LiteralRepoPath {
        path: target,
        dir_only,
    }: LiteralRepoPath<'_>,
    out: &mut BTreeSet<Vec<u8>>,
) -> Result<(), AppError> {
    if (0..=3).any(|stage| {
        exact_entry(index, target.as_bytes(), stage)
            .is_some_and(|e| !dir_only || e.mode == GITLINK_MODE)
    }) {
        out.insert(target.as_bytes().to_vec());
    }
    let prefix = format!("{target}/");
    let start =
        match index.find_prefix(CString::new(prefix.as_bytes()).map_err(|_| {
            AppError::InvalidPath(format!("repository path contains NUL: {target:?}"))
        })?) {
            Ok(pos) => pos,
            Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(()),
            Err(e) => return Err(to_app_err(e)),
        };
    // The index is exact-case (`exact_case_index`), so it is sorted bytewise
    // like git's and the descendants form one exact run.
    let prefix = prefix.as_bytes();
    for pos in start..index.len() {
        let Some(entry) = index.get(pos) else { break };
        if !entry.path.starts_with(prefix) {
            break;
        }
        out.insert(entry.path);
    }
    Ok(())
}

/// The entry at exactly `path` and `stage`. The index is opened exact-case
/// (`exact_case_index`); the byte comparison keeps that an invariant here.
fn exact_entry(index: &git2::Index, path: &[u8], stage: i32) -> Option<IndexEntry> {
    let entry = index.get_path(index_path(path).ok()?, stage)?;
    (entry.path == path).then_some(entry)
}

fn is_conflicted(index: &git2::Index, path: &[u8]) -> bool {
    (1..=3).any(|stage| exact_entry(index, path, stage).is_some())
}

/// The index changes that reset `targets` to `tree`, computed against the
/// unmodified index.
#[derive(Default)]
struct ResetPlan {
    /// Paths whose entries (every stage) are removed first, so a
    /// directory/file swap never collides with the entry it replaces.
    removals: Vec<Vec<u8>>,
    /// Leaves added afterwards, with their preserved skip-worktree bit.
    additions: Vec<(Vec<u8>, Leaf, bool)>,
}

impl ResetPlan {
    fn is_empty(&self) -> bool {
        self.removals.is_empty() && self.additions.is_empty()
    }
}

fn plan_reset(
    repo: &Repository,
    tree: Option<&Tree<'_>>,
    index: &git2::Index,
    targets: &BTreeSet<LiteralRepoPath<'_>>,
) -> Result<ResetPlan, AppError> {
    let mut wanted: BTreeMap<Vec<u8>, Leaf> = BTreeMap::new();
    let mut present: BTreeSet<Vec<u8>> = BTreeSet::new();
    for &target in targets {
        if let Some(tree) = tree {
            tree_leaves_under(repo, tree, target, &mut wanted)?;
        }
        index_paths_under(index, target, &mut present)?;
    }

    let mut plan = ResetPlan::default();
    let candidates: BTreeSet<&Vec<u8>> = present.iter().chain(wanted.keys()).collect();
    for path in candidates {
        let stage0 = exact_entry(index, path, 0);
        let conflicted = is_conflicted(index, path);
        match wanted.get(path) {
            Some(leaf) => {
                let unchanged = !conflicted
                    && stage0.as_ref().is_some_and(|e| {
                        canonical_mode(e.mode) == Some(leaf.mode) && e.id == leaf.id
                    });
                if unchanged {
                    continue;
                }
                let skip_worktree = stage0.as_ref().is_some_and(|e| {
                    e.flags_extended & IndexEntryExtendedFlag::SKIP_WORKTREE.bits() != 0
                });
                if stage0.is_some() || conflicted {
                    plan.removals.push(path.clone());
                }
                plan.additions.push((path.clone(), *leaf, skip_worktree));
            }
            None => {
                if stage0.is_some() || conflicted {
                    plan.removals.push(path.clone());
                }
            }
        }
    }
    Ok(plan)
}

/// The tree of `HEAD`, or `None` on an unborn branch.
pub(crate) fn head_tree(repo: &Repository) -> Result<Option<Tree<'_>>, AppError> {
    match repo.head() {
        Ok(head) => head.peel_to_tree().map(Some).map_err(to_app_err),
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(e) => Err(to_app_err(e)),
    }
}

/// Whether the index differs from `tree` at or below `target`: exactly the
/// paths an unstage of `target` would rewrite (a staged change or a
/// conflict). Exact-case, like every lookup here.
pub(crate) fn index_differs_from_tree(
    repo: &Repository,
    tree: Option<&Tree<'_>>,
    index: &git2::Index,
    target: LiteralRepoPath<'_>,
) -> Result<bool, AppError> {
    Ok(!plan_reset(repo, tree, index, &BTreeSet::from([target]))?.is_empty())
}

/// Reset the index entries at or below each literal path in `paths` to their
/// state in `tree` (`None`: the empty tree of an unborn branch). Every path is
/// validated first; nothing is written if any is rejected.
pub(crate) fn reset_index_paths(
    repo: &Repository,
    tree: Option<&Tree<'_>>,
    paths: &[String],
) -> Result<(), AppError> {
    let targets = paths
        .iter()
        .map(|p| literal_repo_path(p))
        .collect::<Result<BTreeSet<LiteralRepoPath<'_>>, _>>()?;
    let mut index = exact_case_index(repo)?;
    let ResetPlan {
        removals,
        additions,
    } = plan_reset(repo, tree, &index, &targets)?;
    if removals.is_empty() && additions.is_empty() {
        return Ok(());
    }

    for path in &removals {
        for stage in 0..=3 {
            if exact_entry(&index, path, stage).is_some() {
                index.remove(index_path(path)?, stage).map_err(to_app_err)?;
            }
        }
    }
    for (path, leaf, skip_worktree) in additions {
        let flags_extended = if skip_worktree {
            IndexEntryExtendedFlag::SKIP_WORKTREE.bits()
        } else {
            0
        };
        index
            .add(&IndexEntry {
                ctime: IndexTime::new(0, 0),
                mtime: IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: leaf.mode,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: leaf.id,
                flags: 0,
                flags_extended,
                path,
            })
            .map_err(to_app_err)?;
    }
    // libgit2 smudges racily clean entries (`truncate_racily_clean`) only
    // when writing an index that belongs to a repository; an ownerless one
    // would leave a same-size, same-mtime edit invisible to `git status`.
    // Installing it keeps its exact-case capability (caps are read only when
    // the repository loads its own index).
    repo.set_index(&mut index).map_err(to_app_err)?;
    index.write().map_err(to_app_err)
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use tempfile::TempDir;

    /// Run git with a fixed identity and clock, so two runs of the same
    /// scenario produce identical object ids.
    fn git_in(dir: &Path, args: &[&str], input: Option<&str>) -> String {
        let mut child = Command::new("git")
            .current_dir(dir)
            .args(["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false"])
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_AUTHOR_DATE", "2020-01-01T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2020-01-01T00:00:00Z")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.unwrap_or("").as_bytes())
            .unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        git_in(dir, args, None)
    }

    fn write(dir: &Path, rel: &str, contents: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, contents).unwrap();
    }

    fn blob(dir: &Path, contents: &str) -> String {
        git_in(dir, &["hash-object", "-w", "--stdin"], Some(contents))
    }

    fn init(dir: &Path) {
        git(dir, &["init", "-q", "-b", "main"]);
    }

    fn commit(dir: &Path) {
        git(dir, &["commit", "-q", "--allow-empty", "-m", "c"]);
    }

    /// Index as git reports it: tag, mode, id, stage and path per entry.
    fn index_listing(dir: &Path) -> String {
        git(dir, &["ls-files", "-s", "-v", "-z"]).replace('\0', "\n")
    }

    fn unstage(dir: &Path, paths: &[&str]) -> Result<(), crate::error::AppError> {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(crate::git::git_unstage(
                dir.to_str().unwrap().to_string(),
                paths.iter().map(|p| p.to_string()).collect(),
            ))
    }

    /// Build the same scenario twice, unstage `paths` with our command in one
    /// copy and `git --literal-pathspecs reset` in the other, and require
    /// identical index listings.
    fn assert_matches_git(setup: &dyn Fn(&Path), paths: &[&str]) {
        let ours = TempDir::new().unwrap();
        let theirs = TempDir::new().unwrap();
        setup(ours.path());
        setup(theirs.path());
        assert_eq!(index_listing(ours.path()), index_listing(theirs.path()));
        let before = index_listing(ours.path());
        unstage(ours.path(), paths).unwrap_or_else(|e| panic!("unstage {paths:?}: {e:?}"));
        let mut args = vec!["--literal-pathspecs", "reset", "-q", "--"];
        args.extend_from_slice(paths);
        // `git reset` exits 1 when unstaged changes remain; only the index matters.
        let _ = Command::new("git")
            .current_dir(theirs.path())
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(
            index_listing(ours.path()),
            index_listing(theirs.path()),
            "unstaging {paths:?} diverged from git; index before:\n{before}"
        );
    }

    fn base(dir: &Path) {
        init(dir);
        write(dir, "a.txt", "a\n");
        write(dir, "del.txt", "d\n");
        write(dir, "d/x", "x\n");
        write(dir, "d/s/y", "y\n");
        write(dir, "keep.txt", "k\n");
        git(dir, &["add", "-A"]);
        commit(dir);
    }

    /// Set `rel`'s modification time to `secs` after the Unix epoch.
    fn set_mtime(path: &Path, secs: u64) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs))
            .unwrap();
    }

    /// An entry whose stat data cannot prove it clean (mtime not older than
    /// the index the writer read) must be smudged when the index is
    /// rewritten, as `git reset` does; otherwise a same-size edit to it
    /// becomes invisible to `git status` (review of #1589). Timestamps are
    /// set explicitly, so the race is reproduced without timing.
    #[test]
    fn rewriting_the_index_smudges_racily_clean_entries_like_git() {
        let racy_size = |dir: &Path| {
            git(dir, &["ls-files", "--debug", "a"])
                .lines()
                .find_map(|l| l.trim().strip_prefix("size: "))
                .and_then(|rest| rest.split_whitespace().next())
                .map(str::to_owned)
                .unwrap()
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let entry_mtime = now - 100;
        let setup = |dir: &Path| {
            init(dir);
            // Equal ctimes are what make the edit invisible on file systems
            // with coarse timestamps; ignore ctime to model that here.
            git(dir, &["config", "core.trustctime", "false"]);
            write(dir, "a", "AAAA\n");
            write(dir, "b", "b\n");
            git(dir, &["add", "-A"]);
            commit(dir);
            write(dir, "b", "B2\n");
            git(dir, &["add", "b"]);
            set_mtime(&dir.join("a"), entry_mtime);
            git(dir, &["update-index", "-q", "--really-refresh"]);
            // The index was written before `a`'s recorded mtime ...
            set_mtime(&dir.join(".git/index"), entry_mtime - 10);
            // ... and `a` changes without changing size or mtime.
            write(dir, "a", "ZZZZ\n");
            set_mtime(&dir.join("a"), entry_mtime);
        };
        let ours = TempDir::new().unwrap();
        let theirs = TempDir::new().unwrap();
        setup(ours.path());
        setup(theirs.path());
        unstage(ours.path(), &["b"]).unwrap();
        let _ = Command::new("git")
            .current_dir(theirs.path())
            .args(["reset", "-q", "--", "b"])
            .status()
            .unwrap();

        assert_eq!(racy_size(theirs.path()), "0", "git smudges the racy entry");
        assert_eq!(racy_size(ours.path()), racy_size(theirs.path()));
        let status = git(ours.path(), &["status", "--porcelain"]);
        assert!(status.lines().any(|l| l == " M a"), "{status:?}");
    }

    /// `core.ignorecase` makes libgit2 look paths up without regard to case;
    /// unstaging one of two case variants must still touch only that one.
    #[test]
    fn case_variants_under_ignorecase_match_git() {
        let both = |dir: &Path| {
            init(dir);
            write(dir, "a", "1\n");
            write(dir, "A", "1\n");
            git(dir, &["add", "-A"]);
            commit(dir);
            git(dir, &["config", "core.ignorecase", "true"]);
            let two = blob(dir, "2\n");
            let three = blob(dir, "3\n");
            git(
                dir,
                &["update-index", "--cacheinfo", &format!("100644,{two},a")],
            );
            git(
                dir,
                &["update-index", "--cacheinfo", &format!("100644,{three},A")],
            );
        };
        assert_matches_git(&both, &["a"]);
        assert_matches_git(&both, &["A"]);

        let upper_only = |dir: &Path| {
            init(dir);
            write(dir, "a", "1\n");
            write(dir, "A", "1\n");
            git(dir, &["add", "-A"]);
            commit(dir);
            git(dir, &["config", "core.ignorecase", "true"]);
            let two = blob(dir, "2\n");
            git(
                dir,
                &["update-index", "--cacheinfo", &format!("100644,{two},A")],
            );
        };
        assert_matches_git(&upper_only, &["A"]);
        assert_matches_git(&upper_only, &["a"]);

        let file_and_dir = |dir: &Path| {
            init(dir);
            write(dir, "d", "1\n");
            write(dir, "D/x", "1\n");
            git(dir, &["add", "-A"]);
            commit(dir);
            git(dir, &["config", "core.ignorecase", "true"]);
            let two = blob(dir, "2\n");
            git(
                dir,
                &["update-index", "--cacheinfo", &format!("100644,{two},d")],
            );
            git(
                dir,
                &["update-index", "--cacheinfo", &format!("100644,{two},D/x")],
            );
        };
        assert_matches_git(&file_and_dir, &["d"]);
        assert_matches_git(&file_and_dir, &["D"]);
        assert_matches_git(&file_and_dir, &["D/x"]);
    }

    #[test]
    fn staged_modify_add_and_delete_match_git() {
        let setup = |dir: &Path| {
            base(dir);
            write(dir, "a.txt", "a2\n");
            write(dir, "new.txt", "n\n");
            write(dir, "keep.txt", "k2\n");
            git(dir, &["add", "a.txt", "new.txt", "keep.txt"]);
            git(dir, &["rm", "-q", "del.txt"]);
        };
        assert_matches_git(&setup, &["a.txt"]);
        assert_matches_git(&setup, &["new.txt"]);
        assert_matches_git(&setup, &["del.txt"]);
        assert_matches_git(&setup, &["a.txt", "new.txt", "del.txt", "keep.txt"]);
    }

    #[test]
    fn staged_rename_matches_git_for_either_or_both_paths() {
        let setup = |dir: &Path| {
            base(dir);
            git(dir, &["mv", "a.txt", "moved.txt"]);
        };
        assert_matches_git(&setup, &["moved.txt"]);
        assert_matches_git(&setup, &["a.txt"]);
        assert_matches_git(&setup, &["a.txt", "moved.txt"]);
    }

    #[test]
    fn staged_mode_change_matches_git() {
        let setup = |dir: &Path| {
            base(dir);
            git(dir, &["update-index", "--chmod=+x", "a.txt"]);
            git(dir, &["update-index", "--chmod=+x", "d/x"]);
        };
        assert_matches_git(&setup, &["a.txt"]);
        assert_matches_git(&setup, &["d"]);
    }

    #[test]
    fn symlink_and_gitlink_entries_match_git() {
        let setup = |dir: &Path| {
            base(dir);
            let target = blob(dir, "a.txt");
            // file -> symlink, and a new symlink
            git(
                dir,
                &[
                    "update-index",
                    "--cacheinfo",
                    &format!("120000,{target},a.txt"),
                ],
            );
            git(
                dir,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("120000,{target},link"),
                ],
            );
            let head = git(dir, &["rev-parse", "HEAD"]);
            git(
                dir,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("160000,{head},sub"),
                ],
            );
        };
        assert_matches_git(&setup, &["a.txt", "link"]);
        assert_matches_git(&setup, &["sub"]);

        // A committed gitlink whose staged commit changed.
        let setup = |dir: &Path| {
            base(dir);
            let head = git(dir, &["rev-parse", "HEAD"]);
            git(
                dir,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("160000,{head},sub"),
                ],
            );
            commit(dir);
            let next = git(dir, &["rev-parse", "HEAD"]);
            git(
                dir,
                &["update-index", "--cacheinfo", &format!("160000,{next},sub")],
            );
        };
        assert_matches_git(&setup, &["sub"]);
    }

    #[test]
    fn conflict_stages_match_git() {
        let setup = |dir: &Path| {
            base(dir);
            git(dir, &["checkout", "-q", "-b", "side"]);
            write(dir, "a.txt", "side\n");
            git(dir, &["commit", "-q", "-am", "side"]);
            git(dir, &["checkout", "-q", "main"]);
            write(dir, "a.txt", "main\n");
            git(dir, &["commit", "-q", "-am", "main"]);
            let _ = Command::new("git")
                .current_dir(dir)
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    "merge",
                    "-q",
                    "side",
                ])
                .output()
                .unwrap();
            assert!(git(dir, &["ls-files", "-u"]).contains("a.txt"));
        };
        assert_matches_git(&setup, &["a.txt"]);
    }

    #[test]
    fn directory_replaced_by_file_matches_git() {
        let setup = |dir: &Path| {
            base(dir);
            git(dir, &["rm", "-r", "-q", "d"]);
            write(dir, "d", "now a file\n");
            git(dir, &["add", "d"]);
        };
        // The reviewer's failure: `git: invalid entry mode` for the tree at `d`.
        assert_matches_git(&setup, &["d"]);
        assert_matches_git(&setup, &["d/x"]);
        assert_matches_git(&setup, &["d", "a.txt", "keep.txt"]);
    }

    #[test]
    fn file_replaced_by_directory_matches_git() {
        let setup = |dir: &Path| {
            base(dir);
            git(dir, &["rm", "-q", "a.txt"]);
            write(dir, "a.txt/inner", "i\n");
            git(dir, &["add", "a.txt/inner"]);
        };
        assert_matches_git(&setup, &["a.txt"]);
        assert_matches_git(&setup, &["a.txt/inner"]);
    }

    #[test]
    fn sibling_names_and_glob_like_names_stay_literal() {
        let setup = |dir: &Path| {
            init(dir);
            for name in ["a/x", "ab", "a.txt", "f1.txt", "sp ace/ü.txt"] {
                write(dir, name, "1\n");
            }
            git(dir, &["add", "-A"]);
            commit(dir);
            let two = blob(dir, "2\n");
            for name in ["a/x", "ab", "a.txt", "f1.txt", "sp ace/ü.txt"] {
                git(
                    dir,
                    &[
                        "update-index",
                        "--cacheinfo",
                        &format!("100644,{two},{name}"),
                    ],
                );
            }
            git(
                dir,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("100644,{two},f[1].txt"),
                ],
            );
        };
        assert_matches_git(&setup, &["a"]);
        assert_matches_git(&setup, &["f[1].txt"]);
        assert_matches_git(&setup, &["sp ace"]);
    }

    /// A trailing `/` (how status names an untracked directory it does not
    /// descend into) means "directory only", as in git's literal pathspecs.
    #[test]
    fn trailing_slash_names_a_directory_only_like_git() {
        let setup = |dir: &Path| {
            base(dir);
            let two = blob(dir, "2\n");
            git(
                dir,
                &["update-index", "--cacheinfo", &format!("100644,{two},d/x")],
            );
            git(
                dir,
                &[
                    "update-index",
                    "--cacheinfo",
                    &format!("100644,{two},a.txt"),
                ],
            );
            let head = git(dir, &["rev-parse", "HEAD"]);
            git(
                dir,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("160000,{head},sub"),
                ],
            );
        };
        assert_matches_git(&setup, &["d/"]);
        assert_matches_git(&setup, &["a.txt/"]);
        assert_matches_git(&setup, &["sub/"]);
    }

    #[test]
    fn intent_to_add_and_unborn_branch_match_git() {
        let setup = |dir: &Path| {
            base(dir);
            write(dir, "ita.txt", "i\n");
            git(dir, &["add", "-N", "ita.txt"]);
        };
        assert_matches_git(&setup, &["ita.txt"]);

        let unborn = |dir: &Path| {
            init(dir);
            write(dir, "a.txt", "a\n");
            write(dir, "d/x", "x\n");
            git(dir, &["add", "-A"]);
        };
        assert_matches_git(&unborn, &["d"]);
        assert_matches_git(&unborn, &["a.txt", "d/x"]);
    }

    #[test]
    fn legacy_group_writable_tree_mode_resets_as_a_regular_file() {
        // Old trees can record `100664`; git canonicalises it to `100644`.
        let setup = |dir: &Path| {
            init(dir);
            let id = blob(dir, "old\n");
            let raw = {
                let mut bytes = b"100664 f.txt\0".to_vec();
                bytes.extend(
                    (0..id.len())
                        .step_by(2)
                        .map(|i| u8::from_str_radix(&id[i..i + 2], 16).unwrap()),
                );
                bytes
            };
            let tree_file = dir.join(".git/legacy-tree");
            std::fs::write(&tree_file, raw).unwrap();
            let tree = git(
                dir,
                &[
                    "hash-object",
                    "-t",
                    "tree",
                    "-w",
                    "--literally",
                    tree_file.to_str().unwrap(),
                ],
            );
            let c = git(dir, &["commit-tree", &tree, "-m", "legacy"]);
            git(dir, &["update-ref", "refs/heads/main", &c]);
            let new = blob(dir, "new\n");
            git(
                dir,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("100644,{new},f.txt"),
                ],
            );
        };
        assert_matches_git(&setup, &["f.txt"]);
    }

    #[test]
    fn skip_worktree_and_assume_unchanged_bits_match_git() {
        let setup = |dir: &Path| {
            base(dir);
            let two = blob(dir, "2\n");
            // Changed entries carrying each bit, and unchanged ones.
            git(
                dir,
                &[
                    "update-index",
                    "--cacheinfo",
                    &format!("100644,{two},a.txt"),
                ],
            );
            git(
                dir,
                &["update-index", "--cacheinfo", &format!("100644,{two},d/x")],
            );
            git(
                dir,
                &["update-index", "--skip-worktree", "a.txt", "keep.txt"],
            );
            git(dir, &["update-index", "--assume-unchanged", "d/x", "d/s/y"]);
        };
        assert_matches_git(&setup, &["a.txt", "keep.txt"]);
        assert_matches_git(&setup, &["d"]);
    }

    #[test]
    fn unchanged_entries_under_a_directory_keep_their_stat_data() {
        let d = TempDir::new().unwrap();
        let dir = d.path();
        base(dir);
        git(dir, &["update-index", "--refresh"]);
        write(dir, "d/x", "x2\n");
        git(dir, &["add", "d/x"]);
        let stat_of = |path: &str| {
            let debug = git(dir, &["ls-files", "--debug", "--", path]);
            assert!(debug.contains("mtime:"), "{debug}");
            debug
        };
        let before = stat_of("d/s/y");
        assert!(!before.contains("mtime: 0:0"), "{before}");

        unstage(dir, &["d"]).unwrap();

        assert_eq!(stat_of("d/s/y"), before);
        assert_eq!(git(dir, &["diff", "--cached", "--name-only"]), "");
    }

    #[test]
    fn rejects_non_normalised_paths_without_touching_the_index() {
        let d = TempDir::new().unwrap();
        let dir = d.path();
        base(dir);
        write(dir, "a.txt", "a2\n");
        git(dir, &["add", "a.txt"]);
        let before = index_listing(dir);
        for bad in [
            "",
            ".",
            "./a.txt",
            "d/../a.txt",
            "a//b",
            "d//",
            "/",
            "/a.txt",
            ".git/config",
            "d/./x",
        ] {
            let err = unstage(dir, &["a.txt", bad]).expect_err(bad);
            assert!(
                matches!(err, crate::error::AppError::InvalidPath(_)),
                "{bad:?}: {err:?}"
            );
            assert_eq!(index_listing(dir), before, "{bad:?} changed the index");
        }
        let outside = std::env::temp_dir().join("x");
        assert!(unstage(dir, &[outside.to_str().unwrap()]).is_err());
    }

    /// Measurement only: 2,000 staged paths in a 50,000-entry index.
    #[test]
    #[ignore]
    fn measure_unstage_2000_of_50000() {
        let d = TempDir::new().unwrap();
        let p = d.path();
        init(p);
        let a = blob(p, "a\n");
        let b = blob(p, "b\n");
        let paths: Vec<String> = (0..50_000)
            .map(|i| format!("d{:03}/f{i:05}.txt", i / 500))
            .collect();
        let info: String = paths
            .iter()
            .map(|path| format!("100644 {a}\t{path}\n"))
            .collect();
        git_in(p, &["update-index", "--index-info"], Some(&info));
        commit(p);
        let staged: Vec<String> = paths.iter().step_by(25).cloned().collect();
        assert_eq!(staged.len(), 2_000);
        let info: String = staged
            .iter()
            .map(|path| format!("100644 {b}\t{path}\n"))
            .collect();
        git_in(p, &["update-index", "--index-info"], Some(&info));

        let refs: Vec<&str> = staged.iter().map(String::as_str).collect();
        let start = std::time::Instant::now();
        unstage(p, &refs).unwrap();
        eprintln!("MEASURE unstage 2000/50000: {:?}", start.elapsed());
        assert_eq!(git(p, &["diff", "--cached", "--name-only"]), "");
    }
}
