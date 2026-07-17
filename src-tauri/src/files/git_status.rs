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
    Copied,
    Untracked,
    Ignored,
    Conflicted,
    TypeChange,
}

/// Precedence when aggregating multiple children into a directory status:
/// Conflicted > Modified/Added/Deleted/Renamed/Copied/TypeChange > Untracked > Ignored.
fn status_rank(status: &GitFileStatus) -> u8 {
    match status {
        GitFileStatus::Conflicted => 4,
        GitFileStatus::Modified
        | GitFileStatus::Added
        | GitFileStatus::Deleted
        | GitFileStatus::Renamed
        | GitFileStatus::Copied
        | GitFileStatus::TypeChange => 3,
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
        b"DD" | b"AU" | b"UD" | b"UA" | b"DU" | b"AA" | b"UU" => Some(GitFileStatus::Conflicted),
        _ => {
            let index = xy[0];
            let worktree = xy[1];

            if worktree == b'D' || index == b'D' {
                Some(GitFileStatus::Deleted)
            } else if index == b'R' {
                Some(GitFileStatus::Renamed)
            } else if index == b'C' {
                Some(GitFileStatus::Copied)
            } else if index == b'A' {
                Some(GitFileStatus::Added)
            } else if worktree == b'T' || index == b'T' {
                Some(GitFileStatus::TypeChange)
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

/// Truncate stderr for logging, matching the quickfind diagnostics pattern
/// (search.rs): full output can be arbitrarily large (e.g. permission-denied
/// spam), so cap what we log at ~1KB.
fn truncate_stderr(stderr: &[u8]) -> String {
    let mut buf = stderr.to_vec();
    buf.truncate(1024);
    String::from_utf8_lossy(&buf).trim_end().to_string()
}

fn not_a_repo() -> GitStatusResponse {
    GitStatusResponse {
        is_git_repo: false,
        statuses: HashMap::new(),
    }
}

/// Collapse `git status --porcelain -z` output (repo-root-relative paths) into
/// per-entry directory badges for the browsed dir identified by `prefix` (the
/// dir's path relative to the repo root, from `--show-prefix`).
fn aggregate_statuses(status_stdout: &[u8], prefix: &str) -> HashMap<String, GitFileStatus> {
    let mut statuses: HashMap<String, GitFileStatus> = HashMap::new();
    for (repo_rel, status) in parse_porcelain_z(status_stdout) {
        // Porcelain paths are relative to the repo root, not the browsed dir:
        // strip the browsed dir's prefix and skip paths outside it.
        let Some(rel) = repo_rel.strip_prefix(prefix) else {
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
    statuses
}

/// Delegate the two badge-status git calls to the distro's native git for a
/// directory under `\\wsl.localhost\<distro>\…`, avoiding the 9P mount that
/// makes Git-for-Windows 10-30x slower here (#425).
///
/// Returns `Some(response)` for any authoritative answer (repo or not), and
/// `None` only when the delegation *mechanism* failed (spawn error, or a
/// non-zero exit that isn't git's own "not a repository") so the caller can
/// fall back to shelling git over the UNC path. Uses `wsl.exe --exec` for
/// literal argv — `--` would route through the distro's login shell and a
/// shell like zsh mangles paths/args (#423).
#[cfg(windows)]
fn get_git_status_wsl(distro: &str, linux_path: &str, path: &str) -> Option<GitStatusResponse> {
    let rev_parse_start = std::time::Instant::now();
    let output = Command::new("wsl.exe")
        .no_console()
        .args([
            "-d",
            distro,
            "--exec",
            "git",
            "-C",
            linux_path,
            "rev-parse",
            "--is-inside-work-tree",
            "--show-prefix",
        ])
        .output();
    let rev_parse_ms = rev_parse_start.elapsed().as_millis();

    let prefix = match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let mut lines = stdout.lines();
            if lines.next() != Some("true") {
                log::debug!(
                    "gitstat: {path} (wsl {distro}:{linux_path}) is inside a .git dir, not the work tree"
                );
                return Some(not_a_repo());
            }
            lines.next().unwrap_or("").to_string()
        }
        Ok(o) => {
            // Native Linux git has no dubious-ownership problem, so a clean
            // "not a git repository" here is authoritative — reporting it now
            // avoids a redundant (slow, 9P) UNC rev-parse. Anything else
            // (e.g. wsl.exe failed to launch the distro) is a real delegation
            // failure: return None so the caller falls back over the UNC path.
            let stderr = truncate_stderr(&o.stderr);
            let low = stderr.to_ascii_lowercase();
            if low.contains("not a git repository") || low.contains("not a work tree") {
                log::debug!(
                    "gitstat: {path} (wsl {distro}:{linux_path}) not a repo: rev-parse exit {:?} in {rev_parse_ms}ms",
                    o.status.code()
                );
                return Some(not_a_repo());
            }
            log::warn!(
                "gitstat: wsl rev-parse for {distro}:{linux_path} exited {:?} in {rev_parse_ms}ms, stderr: {stderr}",
                o.status.code()
            );
            return None;
        }
        Err(e) => {
            log::warn!("gitstat: wsl rev-parse spawn failed for {distro}:{linux_path}: {e}");
            return None;
        }
    };

    // No `core.filemode` override: native Linux git reports modes correctly,
    // unlike Git-for-Windows over 9P (#392/#398). `-unormal` collapses fully
    // untracked subtrees to one entry (aggregation folds children anyway).
    let status_start = std::time::Instant::now();
    let output = match Command::new("wsl.exe")
        .no_console()
        .args([
            "-d",
            distro,
            "--exec",
            "git",
            "-C",
            linux_path,
            "status",
            "--porcelain",
            "-z",
            "-unormal",
            ".",
        ])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            log::warn!("gitstat: wsl status spawn failed for {distro}:{linux_path}: {e}");
            return None;
        }
    };
    let status_ms = status_start.elapsed().as_millis();
    if !output.status.success() {
        log::warn!(
            "gitstat: wsl status for {distro}:{linux_path} exited {:?} in {status_ms}ms, stderr: {}",
            output.status.code(),
            truncate_stderr(&output.stderr)
        );
        return None;
    }

    let statuses = aggregate_statuses(&output.stdout, &prefix);
    log::info!(
        "gitstat: badge status for {path} via wsl {distro}:{linux_path}: {} entries (rev-parse {rev_parse_ms}ms, status {status_ms}ms)",
        statuses.len()
    );
    Some(GitStatusResponse {
        is_git_repo: true,
        statuses,
    })
}

/// Blocking implementation of [`get_git_status`].
fn get_git_status_sync(path: &str) -> Result<GitStatusResponse, AppError> {
    let total_start = std::time::Instant::now();
    let dir = Path::new(path);
    if !dir.exists() || !dir.is_dir() {
        return Ok(not_a_repo());
    }

    // WSL UNC dirs: delegate to the distro's native git instead of shelling
    // Git-for-Windows over the 9P mount (#425). Fall through to the UNC path
    // only when the delegation mechanism itself fails.
    #[cfg(windows)]
    if let Some((distro, linux_path)) = crate::wsl::parse_wsl_unc(path) {
        if let Some(resp) = get_git_status_wsl(&distro, &linux_path, path) {
            log::info!(
                "gitstat: badge status for {path} served by wsl-delegated in {}ms",
                total_start.elapsed().as_millis()
            );
            return Ok(resp);
        }
        log::warn!("gitstat: falling back to UNC-shelling git for {path}");
    }

    // Check if inside a git repo and resolve the browsed dir's path relative
    // to the repo root in one call: stdout is "true\n<prefix>\n".
    let rev_parse_start = std::time::Instant::now();
    let mut rev_cmd = Command::new("git");
    rev_cmd.no_console();
    // `safe.directory=*` per-invocation: a Linux-created repo browsed over a
    // `\\wsl.localhost` UNC path is owned by a different uid to the Windows
    // user, so a default git config refuses with "dubious ownership" (exit
    // 128) and the dir looks like "not a repo". These are read-only status
    // commands, so trusting ownership here is safe (#425).
    if cfg!(windows) {
        rev_cmd.args(["-c", "safe.directory=*"]);
    }
    let output = rev_cmd
        .args(["rev-parse", "--is-inside-work-tree", "--show-prefix"])
        .current_dir(dir)
        .output();
    let rev_parse_ms = rev_parse_start.elapsed().as_millis();

    let prefix = match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let mut lines = stdout.lines();
            if lines.next() != Some("true") {
                // Inside .git dir, not the work tree: a genuine (if unusual)
                // case, not a failure — debug only to avoid spamming logs for
                // the common "just not a repo" outcome below.
                log::debug!("gitstat: {path} is inside a .git dir, not the work tree");
                None
            } else {
                Some(lines.next().unwrap_or("").to_string())
            }
        }
        Ok(o) => {
            // This is the critical line for diagnosing WSL 9P flakiness: it
            // catches `safe.directory` "dubious ownership" refusals and
            // transient 9P errors that would otherwise be silently swallowed
            // as "not a repo".
            log::warn!(
                "gitstat: {path} treated as not-a-repo: rev-parse exit {:?} in {rev_parse_ms}ms, stderr: {}",
                o.status.code(),
                truncate_stderr(&o.stderr)
            );
            None
        }
        Err(e) => {
            log::warn!("gitstat: rev-parse spawn failed for {path}: {e}");
            None
        }
    };

    let Some(prefix) = prefix else {
        return Ok(not_a_repo());
    };

    // Get porcelain status. `-z` avoids quoting/octal-escaping of non-ASCII
    // paths that the default line format applies. `-unormal` (not `-uall`)
    // reports a fully-untracked directory as one entry instead of enumerating
    // every file inside it — the aggregation below collapses children to the
    // top-level name anyway, and enumerating large untracked trees
    // (build output, node_modules) is by far the costliest part of status.
    let mut cmd = Command::new("git");
    cmd.no_console();
    // Windows can't read the POSIX exec bit (least of all over a
    // `\\wsl.localhost` UNC path), so a Linux-created repo's `core.filemode =
    // true` makes every 0755 file look modified. Git for Windows defaults the
    // setting off; force it per-invocation so the badges agree with the SCM
    // panel and with `git status` inside WSL (#392). `safe.directory=*` for the
    // same dubious-ownership reason as the rev-parse above (#425).
    if cfg!(windows) {
        cmd.args(["-c", "core.filemode=false", "-c", "safe.directory=*"]);
    }
    let status_start = std::time::Instant::now();
    let output = cmd
        .args(["status", "--porcelain", "-z", "-unormal", "."])
        .current_dir(dir)
        .output()
        .map_err(|e| {
            log::warn!("gitstat: status spawn failed for {path}: {e}");
            AppError::from(e)
        })?;
    let status_ms = status_start.elapsed().as_millis();
    // Preserve prior behavior: a non-zero exit still falls through to parsing
    // stdout (typically empty) rather than aborting — only log it here.
    if !output.status.success() {
        log::warn!(
            "gitstat: status call exited non-zero for {path}: exit {:?} in {status_ms}ms, stderr: {}",
            output.status.code(),
            truncate_stderr(&output.stderr)
        );
    }

    let statuses = aggregate_statuses(&output.stdout, &prefix);

    let total_ms = total_start.elapsed().as_millis();
    log::info!(
        "gitstat: badge status for {path}: {} entries (rev-parse {rev_parse_ms}ms, status {status_ms}ms, total {total_ms}ms)",
        statuses.len()
    );

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

    /// Manual diagnostic for #424: run the badge-status path directly against
    /// a live WSL UNC directory and print timings/`gitstat:` log lines.
    /// `cargo test wsl_diag_badge_status -- --ignored --nocapture` with
    /// `WSL_GIT_DIAG_PATH` set to e.g. `\\wsl.localhost\Ubuntu\home\me\repo`.
    #[test]
    #[ignore]
    fn wsl_diag_badge_status() {
        crate::init_test_logger();
        let Ok(path) = std::env::var("WSL_GIT_DIAG_PATH") else {
            println!("WSL_GIT_DIAG_PATH not set; skipping. Example:");
            println!(
                r"  WSL_GIT_DIAG_PATH=\\wsl.localhost\Ubuntu\home\me\repo cargo test wsl_diag_badge_status -- --ignored --nocapture"
            );
            return;
        };
        let start = std::time::Instant::now();
        let result = get_git_status_sync(&path);
        let elapsed = start.elapsed();
        match result {
            Ok(resp) => println!(
                "wsl_diag_badge_status: {path} -> is_git_repo={} entries={} in {:?}",
                resp.is_git_repo,
                resp.statuses.len(),
                elapsed
            ),
            Err(e) => println!("wsl_diag_badge_status: {path} -> ERROR {e:?} in {elapsed:?}"),
        }
    }
}
