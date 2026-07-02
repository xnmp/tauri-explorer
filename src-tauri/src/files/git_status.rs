//! Git status indicators for file entries.
//! Issue: feat/git-status-indicators
//!
//! Runs `git status --porcelain` to detect modified/untracked files
//! in a directory that is inside a git repository.

use serde::Serialize;
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

use crate::error::AppError;
use crate::process_ext::NoConsole;

/// Git status for a single file.
#[derive(Debug, Clone, Serialize)]
pub enum GitFileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    Conflict,
}

/// Precedence when aggregating multiple children into a directory status:
/// Conflict > Modified/Added/Deleted/Renamed > Untracked > Ignored.
fn status_rank(status: &GitFileStatus) -> u8 {
    match status {
        GitFileStatus::Conflict => 4,
        GitFileStatus::Modified
        | GitFileStatus::Added
        | GitFileStatus::Deleted
        | GitFileStatus::Renamed => 3,
        GitFileStatus::Untracked => 2,
        GitFileStatus::Ignored => 1,
    }
}

/// Git status response for a directory.
#[derive(Debug, Serialize)]
pub struct GitStatusResponse {
    /// Whether this directory is inside a git repository
    pub is_git_repo: bool,
    /// Map of filename → git status (only includes files with status)
    pub statuses: HashMap<String, GitFileStatus>,
}

/// Map a porcelain XY status pair to a `GitFileStatus`.
fn parse_xy(xy: &[u8]) -> Option<GitFileStatus> {
    match xy {
        b"??" => Some(GitFileStatus::Untracked),
        b"!!" => Some(GitFileStatus::Ignored),
        b"DD" | b"AU" | b"UD" | b"UA" | b"DU" | b"AA" | b"UU" => Some(GitFileStatus::Conflict),
        _ => {
            let index = xy[0];
            let worktree = xy[1];

            if worktree == b'D' || index == b'D' {
                Some(GitFileStatus::Deleted)
            } else if index == b'R' {
                Some(GitFileStatus::Renamed)
            } else if index == b'A' {
                Some(GitFileStatus::Added)
            } else if worktree == b'M' || index == b'M' {
                Some(GitFileStatus::Modified)
            } else {
                None // clean or unknown
            }
        }
    }
}

/// Parse `git status --porcelain -z` output into (repo-root-relative path,
/// status) pairs. `-z` entries are NUL-separated and never quoted/escaped,
/// so non-ASCII paths come through verbatim. Rename/copy entries place the
/// destination path in the entry itself, followed by an extra NUL-separated
/// field holding the original path (which we consume and ignore).
fn parse_porcelain_z(stdout: &[u8]) -> Vec<(String, GitFileStatus)> {
    let mut out = Vec::new();
    let mut fields = stdout.split(|b| *b == 0);
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            continue;
        }
        let xy = &field[0..2];
        let path = String::from_utf8_lossy(&field[3..]).to_string();
        // Rename/copy entries carry the original path as the next field.
        if xy.contains(&b'R') || xy.contains(&b'C') {
            let _ = fields.next();
        }
        if let Some(status) = parse_xy(xy) {
            out.push((path, status));
        }
    }
    out
}

/// Blocking implementation of [`get_git_status`].
fn get_git_status_sync(path: &str) -> Result<GitStatusResponse, AppError> {
    let dir = Path::new(path);
    if !dir.exists() || !dir.is_dir() {
        return Ok(GitStatusResponse {
            is_git_repo: false,
            statuses: HashMap::new(),
        });
    }

    // Check if inside a git repo and resolve the browsed dir's path relative
    // to the repo root in one call: stdout is "true\n<prefix>\n".
    let output = Command::new("git")
        .no_console()
        .args(["rev-parse", "--is-inside-work-tree", "--show-prefix"])
        .current_dir(dir)
        .output();

    let prefix = match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let mut lines = stdout.lines();
            if lines.next() != Some("true") {
                None // inside .git dir, not the work tree
            } else {
                Some(lines.next().unwrap_or("").to_string())
            }
        }
        _ => None,
    };

    let Some(prefix) = prefix else {
        return Ok(GitStatusResponse {
            is_git_repo: false,
            statuses: HashMap::new(),
        });
    };

    // Get porcelain status. `-z` avoids quoting/octal-escaping of non-ASCII
    // paths that the default line format applies. `-unormal` (not `-uall`)
    // reports a fully-untracked directory as one entry instead of enumerating
    // every file inside it — the aggregation below collapses children to the
    // top-level name anyway, and enumerating large untracked trees
    // (build output, node_modules) is by far the costliest part of status.
    let output = Command::new("git")
        .no_console()
        .args(["status", "--porcelain", "-z", "-unormal", "."])
        .current_dir(dir)
        .output()
        .map_err(AppError::from)?;

    let mut statuses: HashMap<String, GitFileStatus> = HashMap::new();

    for (repo_rel, status) in parse_porcelain_z(&output.stdout) {
        // Porcelain paths are relative to the repo root, not the browsed dir:
        // strip the browsed dir's prefix and skip paths outside it.
        let Some(rel) = repo_rel.strip_prefix(&prefix) else {
            continue;
        };
        // Extract just the entry name (first component relative to dir)
        let name = rel.split('/').next().unwrap_or(rel);
        if name.is_empty() {
            continue;
        }
        match statuses.entry(name.to_string()) {
            Entry::Vacant(e) => {
                e.insert(status);
            }
            Entry::Occupied(mut e) => {
                // Keep the highest-precedence status for a directory entry.
                if status_rank(&status) > status_rank(e.get()) {
                    e.insert(status);
                }
            }
        }
    }

    Ok(GitStatusResponse {
        is_git_repo: true,
        statuses,
    })
}

/// Get git status for all files in the given directory.
#[tauri::command]
pub async fn get_git_status(path: String) -> Result<GitStatusResponse, AppError> {
    tokio::task::spawn_blocking(move || get_git_status_sync(&path))
        .await
        .map_err(|e| AppError::Other(format!("git status task join: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "t@x")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "t@x")
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {:?} failed", args);
    }

    fn init_repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        git(dir.path(), &["init"]);
        git(dir.path(), &["config", "commit.gpgsign", "false"]);
        dir
    }

    fn write(dir: &Path, rel: &str, contents: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, contents).unwrap();
    }

    fn status_of(path: &Path) -> GitStatusResponse {
        get_git_status_sync(path.to_str().unwrap()).unwrap()
    }

    #[test]
    fn statuses_resolve_inside_subdirectory() {
        let dir = init_repo();
        write(dir.path(), "sub/tracked.txt", "v1\n");
        write(dir.path(), "root.txt", "v1\n");
        git(dir.path(), &["add", "-A"]);
        git(dir.path(), &["commit", "-m", "init"]);

        write(dir.path(), "sub/tracked.txt", "v2\n");
        write(dir.path(), "sub/new.txt", "x\n");
        write(dir.path(), "root.txt", "v2\n");

        let resp = status_of(&dir.path().join("sub"));
        assert!(resp.is_git_repo);
        assert!(
            matches!(
                resp.statuses.get("tracked.txt"),
                Some(GitFileStatus::Modified)
            ),
            "statuses={:?}",
            resp.statuses
        );
        assert!(matches!(
            resp.statuses.get("new.txt"),
            Some(GitFileStatus::Untracked)
        ));
        // root.txt lives outside the browsed dir and must not leak in.
        assert!(!resp.statuses.contains_key("root.txt"));
    }

    #[test]
    fn non_ascii_filenames_are_not_escaped() {
        let dir = init_repo();
        write(dir.path(), "keep.txt", "v1\n");
        git(dir.path(), &["add", "-A"]);
        git(dir.path(), &["commit", "-m", "init"]);

        write(dir.path(), "日本語 ümlaut.txt", "x\n");

        let resp = status_of(dir.path());
        assert!(
            matches!(
                resp.statuses.get("日本語 ümlaut.txt"),
                Some(GitFileStatus::Untracked)
            ),
            "statuses={:?}",
            resp.statuses
        );
    }

    #[test]
    fn directory_status_uses_highest_precedence_child() {
        let dir = init_repo();
        write(dir.path(), "pkg/a.txt", "v1\n");
        git(dir.path(), &["add", "-A"]);
        git(dir.path(), &["commit", "-m", "init"]);

        // pkg/ now contains both an untracked and a modified child; the
        // aggregated directory badge must report Modified regardless of
        // which entry git lists first.
        write(dir.path(), "pkg/0-new.txt", "x\n");
        write(dir.path(), "pkg/a.txt", "v2\n");

        let resp = status_of(dir.path());
        assert!(
            matches!(resp.statuses.get("pkg"), Some(GitFileStatus::Modified)),
            "statuses={:?}",
            resp.statuses
        );
    }

    #[test]
    fn fully_untracked_directory_reports_untracked() {
        let dir = init_repo();
        write(dir.path(), "keep.txt", "v1\n");
        git(dir.path(), &["add", "-A"]);
        git(dir.path(), &["commit", "-m", "init"]);

        // With -unormal git reports "?? fresh/" as a single entry; the badge
        // for the directory must still resolve to Untracked.
        write(dir.path(), "fresh/inner/a.txt", "x\n");

        let resp = status_of(dir.path());
        assert!(
            matches!(resp.statuses.get("fresh"), Some(GitFileStatus::Untracked)),
            "statuses={:?}",
            resp.statuses
        );
    }

    #[test]
    fn parse_porcelain_z_handles_rename_entries() {
        // -z rename format: "R  new\0old\0" — old path is a separate field.
        let raw = b"R  new.txt\0old.txt\0?? other.txt\0";
        let parsed = parse_porcelain_z(raw);
        assert_eq!(parsed.len(), 2, "parsed={:?}", parsed);
        assert_eq!(parsed[0].0, "new.txt");
        assert!(matches!(parsed[0].1, GitFileStatus::Renamed));
        assert_eq!(parsed[1].0, "other.txt");
        assert!(matches!(parsed[1].1, GitFileStatus::Untracked));
    }

    #[test]
    fn non_repo_dir_reports_not_a_repo() {
        let dir = TempDir::new().unwrap();
        let resp = status_of(dir.path());
        assert!(!resp.is_git_repo);
        assert!(resp.statuses.is_empty());
    }
}
