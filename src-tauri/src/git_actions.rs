//! Git *mutating* actions for the commit-graph tab — parity with the VSCode
//! "Git Graph" extension's commit context menu (checkout, create branch/tag,
//! cherry-pick, revert, merge, rebase, reset).
//!
//! Deliberately separate from `git_log.rs` (read-only history via libgit2) and
//! from `git.rs` (working-tree / index SCM). These operations shell out to the
//! `git` CLI rather than libgit2: rebase and merge in particular are
//! disproportionately complex to drive correctly through libgit2, and the CLI
//! matches git's own conflict handling exactly. The shell-out style mirrors
//! `files/git_status.rs` (`.no_console()`, `.current_dir()`, `.output()`).
//!
//! ## Conflicts
//!
//! If an operation leaves the repo in a conflicted state (merge/cherry-pick/
//! revert/rebase with conflicts), git exits non-zero and writes an explanatory
//! message to stderr. We surface that stderr as the command error — the SCM
//! panel then shows the conflicted / merge entries as usual. Callers refresh
//! the graph and SCM after the call resolves (success or error).

use std::path::Path;
use std::process::Command;

use crate::error::AppError;
use crate::process_ext::NoConsole;

/// Reject a ref/name/oid that would be parsed by git as an option (leading
/// `-`) or is empty. Prevents an argument like `--force` from being smuggled in
/// as a "branch name". Not a shell-injection guard (we never invoke a shell),
/// purely git-argument hygiene.
fn validate_arg(kind: &str, value: &str) -> Result<(), AppError> {
    let v = value.trim();
    if v.is_empty() {
        return Err(AppError::Other(format!("{kind} must not be empty")));
    }
    if v.starts_with('-') {
        return Err(AppError::Other(format!("invalid {kind}: {v}")));
    }
    Ok(())
}

/// Run `git <args>` in `repo_path`, mapping a non-zero exit to the trimmed
/// stderr (so the frontend can toast git's own message).
fn run_git(repo_path: &str, args: &[&str]) -> Result<(), AppError> {
    let dir = Path::new(repo_path);
    if !dir.is_dir() {
        return Err(AppError::NotFound(repo_path.to_string()));
    }
    let output = Command::new("git")
        .no_console()
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(AppError::from)?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let msg = if stderr.is_empty() {
        format!("git {} failed", args.first().copied().unwrap_or_default())
    } else {
        stderr
    };
    Err(AppError::Other(msg))
}

/// `spawn_blocking` wrapper so a sync `git` invocation never blocks the async
/// runtime. Owns the arg vector to satisfy the `'static` bound.
async fn run_git_async(repo_path: String, args: Vec<String>) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(&repo_path, &refs)
    })
    .await
    .map_err(|e| AppError::Other(format!("git action task join: {e}")))?
}

/// Checkout a branch (attached HEAD) or a commit OID (detached HEAD).
#[tauri::command]
pub async fn git_checkout(repo_path: String, target: String) -> Result<(), AppError> {
    validate_arg("target", &target)?;
    run_git_async(repo_path, vec!["checkout".into(), target]).await
}

/// Create a branch `name` at `oid`. When `checkout` is true, switch to it.
#[tauri::command]
pub async fn git_create_branch(
    repo_path: String,
    name: String,
    oid: String,
    checkout: bool,
) -> Result<(), AppError> {
    validate_arg("branch name", &name)?;
    validate_arg("commit", &oid)?;
    let args = if checkout {
        vec!["checkout".into(), "-b".into(), name, oid]
    } else {
        vec!["branch".into(), name, oid]
    };
    run_git_async(repo_path, args).await
}

/// Create a lightweight tag `name` at `oid`.
#[tauri::command]
pub async fn git_create_tag(repo_path: String, name: String, oid: String) -> Result<(), AppError> {
    validate_arg("tag name", &name)?;
    validate_arg("commit", &oid)?;
    run_git_async(repo_path, vec!["tag".into(), name, oid]).await
}

/// Cherry-pick `oid` onto the current branch.
#[tauri::command]
pub async fn git_cherry_pick(repo_path: String, oid: String) -> Result<(), AppError> {
    validate_arg("commit", &oid)?;
    run_git_async(repo_path, vec!["cherry-pick".into(), oid]).await
}

/// Revert `oid` on the current branch (no editor).
#[tauri::command]
pub async fn git_revert(repo_path: String, oid: String) -> Result<(), AppError> {
    validate_arg("commit", &oid)?;
    run_git_async(repo_path, vec!["revert".into(), "--no-edit".into(), oid]).await
}

/// Merge `target` (branch or OID) into the current branch (no editor).
#[tauri::command]
pub async fn git_merge(repo_path: String, target: String) -> Result<(), AppError> {
    validate_arg("target", &target)?;
    run_git_async(repo_path, vec!["merge".into(), "--no-edit".into(), target]).await
}

/// Rebase the current branch onto `oid`.
#[tauri::command]
pub async fn git_rebase(repo_path: String, oid: String) -> Result<(), AppError> {
    validate_arg("commit", &oid)?;
    run_git_async(repo_path, vec!["rebase".into(), oid]).await
}

/// Reset the current branch to `oid`. `mode` is `soft` | `mixed` | `hard`.
#[tauri::command]
pub async fn git_reset(repo_path: String, oid: String, mode: String) -> Result<(), AppError> {
    validate_arg("commit", &oid)?;
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(AppError::Other(format!("invalid reset mode: {other}"))),
    };
    run_git_async(repo_path, vec!["reset".into(), flag.into(), oid]).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Run a git command in a test repo, asserting success. Sets identity via
    /// env so tests don't depend on host git config.
    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "t@x")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "t@x")
            .args(args)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&status.stderr)
        );
    }

    /// Capture `git <args>` stdout, trimmed.
    fn git_out(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn write(dir: &Path, rel: &str, contents: &str) {
        fs::write(dir.join(rel), contents).unwrap();
    }

    /// Repo with two linear commits on `main`; returns (tempdir, [c1, c2]).
    fn linear_repo() -> (TempDir, Vec<String>) {
        let dir = TempDir::new().unwrap();
        let p = dir.path();
        git(p, &["init", "-b", "main"]);
        git(p, &["config", "commit.gpgsign", "false"]);
        write(p, "a.txt", "1\n");
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "first"]);
        let c1 = git_out(p, &["rev-parse", "HEAD"]);
        write(p, "a.txt", "2\n");
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "second"]);
        let c2 = git_out(p, &["rev-parse", "HEAD"]);
        (dir, vec![c1, c2])
    }

    fn repo_path(dir: &TempDir) -> String {
        dir.path().to_str().unwrap().to_string()
    }

    #[test]
    fn create_branch_at_commit() {
        let (dir, cs) = linear_repo();
        run_git(&repo_path(&dir), &["branch", "topic", &cs[0]]).unwrap();
        // The new branch points at c1, not the tip.
        let target = git_out(dir.path(), &["rev-parse", "topic"]);
        assert_eq!(target, cs[0]);
    }

    #[test]
    fn create_branch_with_checkout_moves_head() {
        let (dir, cs) = linear_repo();
        run_git(&repo_path(&dir), &["checkout", "-b", "topic", &cs[0]]).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), cs[0]);
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "--abbrev-ref", "HEAD"]),
            "topic"
        );
    }

    #[test]
    fn checkout_branch_and_commit() {
        let (dir, cs) = linear_repo();
        let path = repo_path(&dir);
        // Detached checkout of the first commit.
        run_git(&path, &["checkout", &cs[0]]).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), cs[0]);
        // Back to the branch tip.
        run_git(&path, &["checkout", "main"]).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), cs[1]);
    }

    #[test]
    fn create_tag_at_commit() {
        let (dir, cs) = linear_repo();
        run_git(&repo_path(&dir), &["tag", "v1", &cs[0]]).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "v1"]), cs[0]);
    }

    #[test]
    fn reset_hard_moves_branch_and_worktree() {
        let (dir, cs) = linear_repo();
        run_git(&repo_path(&dir), &["reset", "--hard", &cs[0]]).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), cs[0]);
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "1\n");
    }

    #[test]
    fn reset_soft_keeps_worktree() {
        let (dir, cs) = linear_repo();
        run_git(&repo_path(&dir), &["reset", "--soft", &cs[0]]).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), cs[0]);
        // Worktree still has the second commit's content.
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "2\n");
    }

    #[test]
    fn cherry_pick_clean_case() {
        // Build main (base) and a side branch adding a distinct file, then
        // cherry-pick the side commit onto main with no conflict.
        let dir = TempDir::new().unwrap();
        let p = dir.path();
        git(p, &["init", "-b", "main"]);
        git(p, &["config", "commit.gpgsign", "false"]);
        // run_git (production) inherits identity from config; CI runners have
        // no global identity, so set it repo-locally for the cherry-pick.
        git(p, &["config", "user.name", "Test"]);
        git(p, &["config", "user.email", "t@x"]);
        write(p, "a.txt", "base\n");
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "base"]);
        git(p, &["checkout", "-b", "side"]);
        write(p, "b.txt", "from side\n");
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "side change"]);
        let side = git_out(p, &["rev-parse", "HEAD"]);
        git(p, &["checkout", "main"]);

        run_git(&repo_path(&dir), &["cherry-pick", &side]).unwrap();
        // The cherry-picked file now exists on main.
        assert!(p.join("b.txt").exists());
        assert_eq!(
            git_out(p, &["log", "--oneline", "-1", "--format=%s"]),
            "side change"
        );
    }

    #[test]
    fn invalid_reset_mode_rejected() {
        let (dir, cs) = linear_repo();
        let err = tokio_test_block(git_reset(repo_path(&dir), cs[1].clone(), "bogus".into()));
        assert!(matches!(err, Err(AppError::Other(m)) if m.contains("invalid reset mode")));
    }

    #[test]
    fn leading_dash_arg_rejected() {
        let (dir, _cs) = linear_repo();
        let err = tokio_test_block(git_checkout(repo_path(&dir), "--force".into()));
        assert!(matches!(err, Err(AppError::Other(m)) if m.contains("invalid target")));
    }

    #[test]
    fn checkout_missing_ref_surfaces_git_stderr() {
        let (dir, _cs) = linear_repo();
        let err = run_git(&repo_path(&dir), &["checkout", "no-such-branch"]);
        // git's own message is surfaced verbatim.
        assert!(matches!(err, Err(AppError::Other(m))
            if m.to_lowercase().contains("no-such-branch")
                || m.to_lowercase().contains("did not match")));
    }

    /// Minimal single-threaded executor for the few async validation tests —
    /// avoids pulling a runtime macro into the crate's test deps.
    fn tokio_test_block<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(fut)
    }
}
