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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::AppError;
use crate::process_ext::{output_cancellable, NoConsole};
use crate::task_registry::TaskRegistry;

static GIT_NETWORK_OPERATIONS: TaskRegistry = TaskRegistry::new();
const NETWORK_CANCELLED: &str = "git network operation cancelled";
const REMOTE_DELETE_CANCELLED: &str =
    "git network operation cancelled; remote branch may already have been deleted";

/// A successful graph mutation's immutable inverse + expected post-state.
///
/// `git_undo` treats every captured field as a precondition. The frontend
/// stores these values only for the current session; it never manufactures
/// them from display state.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GitUndoAction {
    BranchDelete {
        name: String,
        target: String,
    },
    TagDelete {
        name: String,
        target: String,
    },
    BranchRename {
        old_name: String,
        new_name: String,
        target: String,
    },
    HeadMove {
        operation: HeadMoveOperation,
        branch: Option<String>,
        before_oid: String,
        after_oid: String,
    },
}

#[derive(Debug, Clone, Copy, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HeadMoveOperation {
    Merge,
    Pull,
}

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
    run_git_with_env(repo_path, args, &[])
}

/// Like `run_git` but with extra environment variables. Used to set
/// `GIT_EDITOR=true` for `rebase --continue`, so git never blocks waiting on
/// an interactive editor in a headless/desktop context.
fn run_git_with_env(repo_path: &str, args: &[&str], envs: &[(&str, &str)]) -> Result<(), AppError> {
    let dir = Path::new(repo_path);
    if !dir.is_dir() {
        return Err(AppError::NotFound(repo_path.to_string()));
    }
    let mut cmd = Command::new("git");
    cmd.no_console().args(args).current_dir(dir);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let output = cmd.output().map_err(AppError::from)?;

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

fn run_git_network_sync(
    repo_path: &str,
    args: &[&str],
    cancelled: &AtomicBool,
    program: &str,
) -> Result<(), AppError> {
    run_git_network_sync_after_output(
        repo_path,
        args,
        cancelled,
        program,
        NETWORK_CANCELLED,
        || {},
    )
}

fn run_git_network_sync_after_output<F>(
    repo_path: &str,
    args: &[&str],
    cancelled: &AtomicBool,
    program: &str,
    cancel_message: &'static str,
    after_output: F,
) -> Result<(), AppError>
where
    F: FnOnce(),
{
    let dir = Path::new(repo_path);
    if !dir.is_dir() {
        return Err(AppError::NotFound(repo_path.to_string()));
    }
    let mut command = Command::new(program);
    command.no_console().args(args).current_dir(dir);
    let output = output_cancellable(&mut command, cancelled, cancel_message)?;
    after_output();
    if cancelled.load(Ordering::Relaxed) {
        return Err(AppError::Other(cancel_message.into()));
    }
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(AppError::Other(if stderr.is_empty() {
        format!("git {} failed", args.first().copied().unwrap_or_default())
    } else {
        stderr
    }))
}

async fn run_git_network_task<T, F>(task_id: u64, work: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(Arc<AtomicBool>) -> Result<T, AppError> + Send + 'static,
{
    let cancelled = GIT_NETWORK_OPERATIONS.start_with_id(task_id);
    let joined = tokio::task::spawn_blocking(move || work(cancelled))
        .await
        .map_err(|error| AppError::Other(format!("git network task join: {error}")));
    GIT_NETWORK_OPERATIONS.cleanup(task_id);
    joined?
}

async fn run_git_network_with_program(
    repo_path: String,
    args: Vec<String>,
    task_id: u64,
    program: String,
) -> Result<(), AppError> {
    run_git_network_task(task_id, move |cancelled| {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git_network_sync(&repo_path, &refs, &cancelled, &program)
    })
    .await
}

async fn run_git_network(
    repo_path: String,
    args: Vec<String>,
    task_id: u64,
    cancel_message: &'static str,
) -> Result<(), AppError> {
    run_git_network_task(task_id, move |cancelled| {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git_network_sync_after_output(
            &repo_path,
            &refs,
            &cancelled,
            "git",
            cancel_message,
            || {},
        )
    })
    .await
}

/// Match `git fetch --all`'s configured-remote eligibility while allowing the
/// eligible remotes to be fetched in separate atomic transactions (ADR 0006).
fn fetch_all_eligible_remotes(repo_path: &str) -> Result<Vec<String>, AppError> {
    let repo = crate::git_common::open_repo(Path::new(repo_path))?;
    let remotes = repo.remotes().map_err(crate::git_common::to_app_err)?;
    let config = repo.config().map_err(crate::git_common::to_app_err)?;
    let config_bool = |key: &str| match config.get_bool(key) {
        Ok(value) => Ok(value),
        Err(error) if error.code() == git2::ErrorCode::NotFound => Ok(false),
        Err(error) => Err(crate::git_common::to_app_err(error)),
    };

    let mut eligible = Vec::with_capacity(remotes.len());
    for name in remotes.iter() {
        let name =
            name.ok_or_else(|| AppError::Other("git remote name is not valid UTF-8".into()))?;
        let skip_fetch_all = config_bool(&format!("remote.{name}.skipFetchAll"))?;
        let skip_default_update = config_bool(&format!("remote.{name}.skipDefaultUpdate"))?;
        if !skip_fetch_all && !skip_default_update {
            eligible.push(name.to_owned());
        }
    }
    Ok(eligible)
}

fn fetch_all_remotes_sync_with_hook<F>(
    repo_path: &str,
    cancelled: &AtomicBool,
    mut after_remote: F,
) -> Result<(), AppError>
where
    F: FnMut(&str, &AtomicBool),
{
    if cancelled.load(Ordering::Relaxed) {
        return Err(AppError::Other(NETWORK_CANCELLED.into()));
    }

    for remote in fetch_all_eligible_remotes(repo_path)? {
        run_git_network_sync(
            repo_path,
            &["fetch", "--prune", "--atomic", &remote],
            cancelled,
            "git",
        )?;
        after_remote(&remote, cancelled);
        if cancelled.load(Ordering::Relaxed) {
            return Err(AppError::Other(NETWORK_CANCELLED.into()));
        }
    }
    Ok(())
}

async fn run_fetch_all_remotes(repo_path: String, task_id: u64) -> Result<(), AppError> {
    run_git_network_task(task_id, move |cancelled| {
        fetch_all_remotes_sync_with_hook(&repo_path, &cancelled, |_, _| {})
    })
    .await
}

#[tauri::command]
pub async fn cancel_git_network_operation(task_id: u64) -> Result<(), AppError> {
    GIT_NETWORK_OPERATIONS.cancel(task_id);
    Ok(())
}

/// `run_git_with_env` behind `spawn_blocking`, owning its args/envs.
async fn run_git_env_async(
    repo_path: String,
    args: Vec<String>,
    envs: Vec<(String, String)>,
) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let env_refs: Vec<(&str, &str)> =
            envs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        run_git_with_env(&repo_path, &refs, &env_refs)
    })
    .await
    .map_err(|e| AppError::Other(format!("git action task join: {e}")))?
}

fn ref_target(repo_path: &str, ref_name: &str, label: &str) -> Result<String, AppError> {
    let repo = crate::git_common::open_repo(Path::new(repo_path))?;
    let reference = repo
        .find_reference(ref_name)
        .map_err(|_| AppError::Other(format!("{label} does not exist")))?;
    let object = reference
        .peel(git2::ObjectType::Commit)
        .map_err(crate::git_common::to_app_err)?;
    Ok(object.id().to_string())
}

fn raw_ref_target(repo_path: &str, ref_name: &str, label: &str) -> Result<String, AppError> {
    let repo = crate::git_common::open_repo(Path::new(repo_path))?;
    let reference = repo
        .find_reference(ref_name)
        .map_err(|_| AppError::Other(format!("{label} does not exist")))?;
    reference
        .target()
        .map(|oid| oid.to_string())
        .ok_or_else(|| AppError::Other(format!("{label} has no direct target")))
}

fn head_snapshot(repo_path: &str) -> Result<(String, Option<String>), AppError> {
    let repo = crate::git_common::open_repo(Path::new(repo_path))?;
    let head = repo.head().map_err(crate::git_common::to_app_err)?;
    let oid = head
        .target()
        .ok_or_else(|| AppError::Other("HEAD has no target commit".into()))?;
    let branch = if head.is_branch() {
        head.shorthand().map(str::to_owned)
    } else {
        None
    };
    Ok((oid.to_string(), branch))
}

fn working_tree_is_clean(repo_path: &str) -> Result<bool, AppError> {
    let status = Command::new("git")
        .no_console()
        .args(["status", "--porcelain", "--untracked-files=normal"])
        .current_dir(repo_path)
        .output()
        .map_err(AppError::from)?;
    if !status.status.success() {
        return Err(AppError::Other("could not inspect working tree".into()));
    }
    Ok(status.stdout.is_empty())
}

fn working_tree_matches_commit(repo_path: &str, oid: &str) -> Result<bool, AppError> {
    let diff = Command::new("git")
        .no_console()
        .args(["diff", "--quiet", oid, "--"])
        .current_dir(repo_path)
        .status()
        .map_err(AppError::from)?;
    if !matches!(diff.code(), Some(0 | 1)) {
        return Err(AppError::Other("could not compare working tree".into()));
    }
    let untracked = Command::new("git")
        .no_console()
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(repo_path)
        .output()
        .map_err(AppError::from)?;
    if !untracked.status.success() {
        return Err(AppError::Other(
            "could not inspect untracked working-tree files".into(),
        ));
    }
    Ok(diff.success() && untracked.stdout.is_empty())
}

fn update_ref_cas(
    repo_path: &str,
    ref_name: &str,
    new_oid: &str,
    expected_old_oid: &str,
) -> Result<(), AppError> {
    run_git(
        repo_path,
        &["update-ref", ref_name, new_oid, expected_old_oid],
    )
}

fn undo_head_move(
    repo_path: &str,
    branch: Option<&str>,
    before_oid: &str,
    after_oid: &str,
    after_ref_move: impl FnOnce(),
) -> Result<(), AppError> {
    let (actual_oid, actual_branch) = head_snapshot(repo_path)?;
    if actual_oid != after_oid || actual_branch.as_deref() != branch {
        return Err(AppError::Other(
            "HEAD moved since the operation; undo is no longer safe".into(),
        ));
    }
    if !working_tree_is_clean(repo_path)? {
        return Err(AppError::Other(
            "working tree is not clean; undo was refused".into(),
        ));
    }

    // Move the checked-out ref with an expected-old compare-and-swap. A
    // concurrent commit between the snapshot and this point makes update-ref
    // fail instead of rewinding that commit.
    let head_ref = match branch {
        Some(name) => {
            validate_arg("branch name", name)?;
            format!("refs/heads/{name}")
        }
        None => "HEAD".to_string(),
    };
    update_ref_cas(repo_path, &head_ref, before_oid, after_oid).map_err(|_| {
        AppError::Other("HEAD moved since the safety check; undo was refused".into())
    })?;
    after_ref_move();

    // Catch worktree changes that landed while the ref CAS ran. HEAD now
    // names `before_oid`, so compare the index/worktree directly with the
    // captured post-operation tree instead of `git status`. Every exit after
    // the CAS first tries an expected-old rollback, including inspection
    // errors, so a failed undo cannot leave HEAD partially rewound.
    match working_tree_matches_commit(repo_path, after_oid) {
        Ok(true) => {}
        Ok(false) => {
            let _ = update_ref_cas(repo_path, &head_ref, after_oid, before_oid);
            return Err(AppError::Other(
                "working tree changed during undo; undo was refused".into(),
            ));
        }
        Err(error) => {
            let rollback = update_ref_cas(repo_path, &head_ref, after_oid, before_oid);
            return match rollback {
                Ok(()) => Err(AppError::Other(format!(
                    "could not verify the working tree; undo was rolled back: {error}"
                ))),
                Err(rollback_error) => Err(AppError::Other(format!(
                    "could not verify the working tree and the ref changed concurrently: {error}; {rollback_error}"
                ))),
            };
        }
    }

    // Two-tree read-tree is the worktree/index counterpart to the ref CAS: it
    // transitions only paths matching the old tree and refuses to overwrite
    // a racing local edit. It does not move HEAD.
    if let Err(error) = run_git(repo_path, &["read-tree", "-u", "-m", after_oid, before_oid]) {
        let rollback = update_ref_cas(repo_path, &head_ref, after_oid, before_oid);
        return match rollback {
            Ok(()) => Err(AppError::Other(format!(
                "working tree changed during undo; undo was rolled back: {error}"
            ))),
            Err(rollback_error) => Err(AppError::Other(format!(
                "undo could not update the worktree and the ref changed concurrently: {error}; {rollback_error}"
            ))),
        };
    }
    let (final_oid, final_branch) = head_snapshot(repo_path)?;
    if final_oid != before_oid || final_branch.as_deref() != branch {
        return Err(AppError::Other(
            "HEAD changed concurrently while finishing undo".into(),
        ));
    }
    Ok(())
}

async fn run_head_move(
    repo_path: String,
    operation: HeadMoveOperation,
    args: Vec<String>,
) -> Result<Option<GitUndoAction>, AppError> {
    tokio::task::spawn_blocking(move || {
        let (before_oid, branch) = head_snapshot(&repo_path)?;
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_git(&repo_path, &refs)?;
        let (after_oid, after_branch) = head_snapshot(&repo_path)?;
        if branch != after_branch {
            return Err(AppError::Other(
                "git operation unexpectedly changed the checked-out branch".into(),
            ));
        }
        Ok(
            (before_oid != after_oid).then_some(GitUndoAction::HeadMove {
                operation,
                branch,
                before_oid,
                after_oid,
            }),
        )
    })
    .await
    .map_err(|e| AppError::Other(format!("git action task join: {e}")))?
}

fn run_pull_sync_with_hooks<AfterFetch, FastForwardStarted>(
    repo_path: &str,
    cancelled: &AtomicBool,
    after_fetch: AfterFetch,
    fast_forward_started: FastForwardStarted,
) -> Result<Option<GitUndoAction>, AppError>
where
    AfterFetch: FnOnce(&AtomicBool),
    FastForwardStarted: FnOnce(&AtomicBool),
{
    let (before_oid, branch) = head_snapshot(repo_path)?;
    run_git_network_sync(repo_path, &["fetch", "--atomic"], cancelled, "git")?;
    after_fetch(cancelled);
    if cancelled.load(Ordering::Relaxed) {
        return Err(AppError::Other(NETWORK_CANCELLED.into()));
    }

    // Cancellation owns only the unbounded network phase. Once this boundary
    // is crossed, let Git's local fast-forward finish so HEAD/index/worktree
    // are never exposed to process-tree termination (ADR 0006).
    fast_forward_started(cancelled);
    run_git(repo_path, &["merge", "--ff-only", "@{upstream}"])?;

    let (after_oid, after_branch) = head_snapshot(repo_path)?;
    if branch != after_branch {
        return Err(AppError::Other(
            "git operation unexpectedly changed the checked-out branch".into(),
        ));
    }
    Ok(
        (before_oid != after_oid).then_some(GitUndoAction::HeadMove {
            operation: HeadMoveOperation::Pull,
            branch,
            before_oid,
            after_oid,
        }),
    )
}

async fn run_network_pull(
    repo_path: String,
    task_id: u64,
) -> Result<Option<GitUndoAction>, AppError> {
    run_git_network_task(task_id, move |cancelled| {
        run_pull_sync_with_hooks(&repo_path, &cancelled, |_| {}, |_| {})
    })
    .await
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
pub async fn git_merge(
    repo_path: String,
    target: String,
) -> Result<Option<GitUndoAction>, AppError> {
    validate_arg("target", &target)?;
    run_head_move(
        repo_path,
        HeadMoveOperation::Merge,
        vec!["merge".into(), "--no-edit".into(), target],
    )
    .await
}

/// Rebase the current branch onto `oid`.
#[tauri::command]
pub async fn git_rebase(repo_path: String, oid: String) -> Result<(), AppError> {
    validate_arg("commit", &oid)?;
    run_git_async(repo_path, vec!["rebase".into(), oid]).await
}

/// Apply a named stash without dropping it from the stash list.
#[tauri::command]
pub async fn git_stash_apply(repo_path: String, stash: String) -> Result<(), AppError> {
    validate_arg("stash", &stash)?;
    run_git_async(repo_path, vec!["stash".into(), "apply".into(), stash]).await
}

/// Apply a named stash and remove it only after a successful apply.
#[tauri::command]
pub async fn git_stash_pop(repo_path: String, stash: String) -> Result<(), AppError> {
    validate_arg("stash", &stash)?;
    run_git_async(repo_path, vec!["stash".into(), "pop".into(), stash]).await
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

// ----- In-progress operation abort / continue (#294) ----- //
//
// These drive the SCM panel's in-progress banner. They shell out exactly like
// the operations above and surface git's own stderr on failure.

/// Abort an in-progress merge, restoring the pre-merge working tree/index.
#[tauri::command]
pub async fn git_merge_abort(repo_path: String) -> Result<(), AppError> {
    run_git_async(repo_path, vec!["merge".into(), "--abort".into()]).await
}

/// Abort an in-progress rebase, returning to the original branch state.
#[tauri::command]
pub async fn git_rebase_abort(repo_path: String) -> Result<(), AppError> {
    run_git_async(repo_path, vec!["rebase".into(), "--abort".into()]).await
}

/// Continue an in-progress rebase after conflicts have been resolved and
/// staged. `GIT_EDITOR=true` prevents git from opening an editor for the
/// commit message, which would otherwise block indefinitely.
#[tauri::command]
pub async fn git_rebase_continue(repo_path: String) -> Result<(), AppError> {
    run_git_env_async(
        repo_path,
        vec!["rebase".into(), "--continue".into()],
        vec![("GIT_EDITOR".into(), "true".into())],
    )
    .await
}

/// Abort an in-progress cherry-pick sequence.
#[tauri::command]
pub async fn git_cherry_pick_abort(repo_path: String) -> Result<(), AppError> {
    run_git_async(repo_path, vec!["cherry-pick".into(), "--abort".into()]).await
}

/// Abort an in-progress revert sequence.
#[tauri::command]
pub async fn git_revert_abort(repo_path: String) -> Result<(), AppError> {
    run_git_async(repo_path, vec!["revert".into(), "--abort".into()]).await
}

/// Fetch from every remote, pruning deleted remote branches (#370). Each remote
/// is fetched atomically because Git rejects `--all --atomic` for repositories
/// with multiple remotes. Uses the CLI so the user's credential setup (helpers,
/// ssh agent) applies — libgit2 has no access to those.
#[tauri::command]
pub async fn git_fetch(repo_path: String, task_id: u64) -> Result<(), AppError> {
    run_fetch_all_remotes(repo_path, task_id).await
}

/// Fast-forward pull on the current branch (#377). `--ff-only` so a diverged
/// branch errors (surfaced verbatim) instead of creating a surprise merge.
#[tauri::command]
pub async fn git_pull(repo_path: String, task_id: u64) -> Result<Option<GitUndoAction>, AppError> {
    run_network_pull(repo_path, task_id).await
}

/// How many commits `name`'s upstream has that the local branch lacks
/// (#377): 0 = up to date or ahead; None = no upstream configured.
#[tauri::command]
pub async fn git_branch_behind_upstream(
    repo_path: String,
    name: String,
) -> Result<Option<usize>, AppError> {
    validate_arg("branch name", &name)?;
    tokio::task::spawn_blocking(move || {
        let repo = crate::git_common::open_repo(Path::new(&repo_path))?;
        let branch = repo
            .find_branch(&name, git2::BranchType::Local)
            .map_err(crate::git_common::to_app_err)?;
        let Ok(upstream) = branch.upstream() else {
            return Ok(None);
        };
        let (Some(local), Some(remote)) = (branch.get().target(), upstream.get().target()) else {
            return Ok(None);
        };
        let (_ahead, behind) = repo
            .graph_ahead_behind(local, remote)
            .map_err(crate::git_common::to_app_err)?;
        Ok(Some(behind))
    })
    .await
    .map_err(|e| AppError::Other(format!("git action task join: {e}")))?
}

/// Delete a local branch (#371). `force` uses `-D` (drops unmerged commits);
/// otherwise `-d`, and git's "not fully merged" refusal is surfaced verbatim.
/// git itself refuses to delete the checked-out branch.
#[tauri::command]
pub async fn git_delete_branch(
    repo_path: String,
    name: String,
    force: bool,
) -> Result<GitUndoAction, AppError> {
    validate_arg("branch name", &name)?;
    let flag = if force { "-D" } else { "-d" };
    tokio::task::spawn_blocking(move || {
        let target = ref_target(
            &repo_path,
            &format!("refs/heads/{name}"),
            &format!("branch '{name}'"),
        )?;
        run_git(&repo_path, &["branch", flag, &name])?;
        Ok(GitUndoAction::BranchDelete { name, target })
    })
    .await
    .map_err(|e| AppError::Other(format!("git action task join: {e}")))?
}

/// Delete a local tag and return the exact commit needed to recreate it.
#[tauri::command]
pub async fn git_delete_tag(repo_path: String, name: String) -> Result<GitUndoAction, AppError> {
    validate_arg("tag name", &name)?;
    tokio::task::spawn_blocking(move || {
        // Keep the raw tag-object OID rather than peeling to its commit so an
        // annotated tag is restored byte-for-byte, not downgraded to a
        // lightweight tag.
        let target = raw_ref_target(
            &repo_path,
            &format!("refs/tags/{name}"),
            &format!("tag '{name}'"),
        )?;
        run_git(&repo_path, &["tag", "-d", &name])?;
        Ok(GitUndoAction::TagDelete { name, target })
    })
    .await
    .map_err(|e| AppError::Other(format!("git action task join: {e}")))?
}

/// Rename a local branch and capture the ref state required to rename it back.
#[tauri::command]
pub async fn git_rename_branch(
    repo_path: String,
    old_name: String,
    new_name: String,
) -> Result<GitUndoAction, AppError> {
    validate_arg("old branch name", &old_name)?;
    validate_arg("new branch name", &new_name)?;
    tokio::task::spawn_blocking(move || {
        let target = ref_target(
            &repo_path,
            &format!("refs/heads/{old_name}"),
            &format!("branch '{old_name}'"),
        )?;
        run_git(&repo_path, &["branch", "-m", &old_name, &new_name])?;
        Ok(GitUndoAction::BranchRename {
            old_name,
            new_name,
            target,
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("git action task join: {e}")))?
}

/// Re-verify a recorded mutation and apply its inverse as one backend action.
///
/// The checks happen immediately before the inverse in the same blocking task,
/// closing the frontend check-to-command race. A stale action is refused
/// without changing the repository.
#[tauri::command]
pub async fn git_undo(repo_path: String, action: GitUndoAction) -> Result<(), AppError> {
    tokio::task::spawn_blocking(move || match action {
        GitUndoAction::BranchDelete { name, target } => {
            validate_arg("branch name", &name)?;
            validate_arg("commit", &target)?;
            let repo = crate::git_common::open_repo(Path::new(&repo_path))?;
            if repo.find_reference(&format!("refs/heads/{name}")).is_ok() {
                return Err(AppError::Other(format!(
                    "branch '{name}' already exists; undo is no longer safe"
                )));
            }
            run_git(&repo_path, &["branch", &name, &target])
        }
        GitUndoAction::TagDelete { name, target } => {
            validate_arg("tag name", &name)?;
            validate_arg("commit", &target)?;
            let repo = crate::git_common::open_repo(Path::new(&repo_path))?;
            if repo.find_reference(&format!("refs/tags/{name}")).is_ok() {
                return Err(AppError::Other(format!(
                    "tag '{name}' already exists; undo is no longer safe"
                )));
            }
            let ref_name = format!("refs/tags/{name}");
            run_git(
                &repo_path,
                &[
                    "update-ref",
                    &ref_name,
                    &target,
                    "0000000000000000000000000000000000000000",
                ],
            )
        }
        GitUndoAction::BranchRename {
            old_name,
            new_name,
            target,
        } => {
            validate_arg("old branch name", &old_name)?;
            validate_arg("new branch name", &new_name)?;
            validate_arg("commit", &target)?;
            let repo = crate::git_common::open_repo(Path::new(&repo_path))?;
            if repo
                .find_reference(&format!("refs/heads/{old_name}"))
                .is_ok()
            {
                return Err(AppError::Other(format!(
                    "branch '{old_name}' already exists; undo is no longer safe"
                )));
            }
            let actual = ref_target(
                &repo_path,
                &format!("refs/heads/{new_name}"),
                &format!("branch '{new_name}'"),
            )?;
            if actual != target {
                return Err(AppError::Other(format!(
                    "branch '{new_name}' moved; undo is no longer safe"
                )));
            }
            run_git(&repo_path, &["branch", "-m", &new_name, &old_name])
        }
        GitUndoAction::HeadMove {
            operation: _,
            branch,
            before_oid,
            after_oid,
        } => {
            validate_arg("previous commit", &before_oid)?;
            validate_arg("current commit", &after_oid)?;
            undo_head_move(
                &repo_path,
                branch.as_deref(),
                &before_oid,
                &after_oid,
                || {},
            )
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("git action task join: {e}")))?
}

/// Delete a branch on a remote (#371): `git push <remote> --delete <name>`.
/// CLI for the same credential reasons as `git_fetch`.
#[tauri::command]
pub async fn git_delete_remote_branch(
    repo_path: String,
    remote: String,
    name: String,
    task_id: u64,
) -> Result<(), AppError> {
    validate_arg("remote", &remote)?;
    validate_arg("branch name", &name)?;
    run_git_network(
        repo_path,
        vec!["push".into(), remote, "--delete".into(), name],
        task_id,
        REMOTE_DELETE_CANCELLED,
    )
    .await
}

/// Checkout a remote-tracking branch as a local one (#432). If a local branch
/// `name` already exists, plainly check it out; otherwise create a local branch
/// tracking `<remote>/<name>` (`git checkout -b <name> --track <remote>/<name>`).
#[tauri::command]
pub async fn git_checkout_tracking(
    repo_path: String,
    remote: String,
    name: String,
) -> Result<(), AppError> {
    validate_arg("remote", &remote)?;
    validate_arg("branch name", &name)?;
    tokio::task::spawn_blocking(move || {
        let local_exists = crate::git_common::open_repo(Path::new(&repo_path))
            .ok()
            .and_then(|repo| {
                repo.find_branch(&name, git2::BranchType::Local)
                    .ok()
                    .map(|_| ())
            })
            .is_some();
        if local_exists {
            // A local branch with that name already exists — just switch to it.
            run_git(&repo_path, &["checkout", &name])
        } else {
            let tracking = format!("{remote}/{name}");
            run_git(&repo_path, &["checkout", "-b", &name, "--track", &tracking])
        }
    })
    .await
    .map_err(|e| AppError::Other(format!("git action task join: {e}")))?
}

/// Outcome of a local-branch sync (#432).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SyncLocalBranchesResult {
    /// Branches fast-forwarded to their upstream.
    pub fast_forwarded: Vec<String>,
    /// Branches that have diverged (ahead > 0 AND behind > 0) — left untouched.
    pub diverged: Vec<String>,
    /// Branches skipped for safety (the checked-out branch with a dirty tree,
    /// or a fast-forward that git unexpectedly refused).
    pub skipped: Vec<String>,
}

/// True when `git status --porcelain` is empty (clean working tree/index).
fn working_tree_clean(repo_path: &str) -> bool {
    let mut cmd = Command::new("git");
    cmd.no_console()
        .args(["status", "--porcelain"])
        .current_dir(Path::new(repo_path));
    cmd.output()
        .map(|o| o.status.success() && o.stdout.is_empty())
        .unwrap_or(false)
}

fn sync_local_branches(repo_path: &str) -> Result<SyncLocalBranchesResult, AppError> {
    let repo = crate::git_common::open_repo(Path::new(repo_path))?;
    let mut result = SyncLocalBranchesResult::default();

    let head_branch = repo
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    // Collect the plan first — mutating refs while iterating repo.branches()
    // would invalidate the iterator. Each entry is a branch strictly behind
    // its upstream with nothing unpushed (a safe fast-forward candidate).
    let mut plans: Vec<(String, git2::Oid)> = Vec::new();
    for (branch, _t) in repo
        .branches(Some(git2::BranchType::Local))
        .map_err(crate::git_common::to_app_err)?
        .flatten()
    {
        let Some(name) = branch.name().ok().flatten().map(str::to_string) else {
            continue;
        };
        let Ok(upstream) = branch.upstream() else {
            continue; // no upstream configured — nothing to sync
        };
        let (Some(local), Some(remote)) = (branch.get().target(), upstream.get().target()) else {
            continue;
        };
        if local == remote {
            continue; // already in sync
        }
        let (ahead, behind) = repo
            .graph_ahead_behind(local, remote)
            .map_err(crate::git_common::to_app_err)?;
        if behind == 0 {
            continue; // up to date or purely ahead — nothing to pull down
        }
        if ahead > 0 {
            result.diverged.push(name); // diverged — never touch
            continue;
        }
        plans.push((name, remote));
    }

    for (name, remote) in plans {
        if head_branch.as_deref() == Some(name.as_str()) {
            // The checked-out branch is only advanced via merge --ff-only, and
            // only with a clean tree; anything uncertain is skipped, not forced.
            if working_tree_clean(repo_path) && run_git(repo_path, &["merge", "--ff-only"]).is_ok()
            {
                result.fast_forwarded.push(name);
            } else {
                result.skipped.push(name);
            }
        } else {
            // Non-checked-out branch: advance its ref directly. Safe because the
            // upstream strictly descends from the current tip (behind, ahead=0).
            let refname = format!("refs/heads/{name}");
            if run_git(repo_path, &["update-ref", &refname, &remote.to_string()]).is_ok() {
                result.fast_forwarded.push(name);
            } else {
                result.skipped.push(name);
            }
        }
    }

    Ok(result)
}

/// Fast-forward every local branch strictly behind its upstream (#432). The
/// checked-out branch is only advanced via `git merge --ff-only` on a clean
/// tree (skipped otherwise); diverged branches are reported, never moved.
/// Assumes the caller already fetched (the graph's F5 does).
#[tauri::command]
pub async fn git_sync_local_branches(
    repo_path: String,
) -> Result<SyncLocalBranchesResult, AppError> {
    tokio::task::spawn_blocking(move || sync_local_branches(&repo_path))
        .await
        .map_err(|e| AppError::Other(format!("git action task join: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
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
        // Application commands run in separate subprocesses from this test
        // helper, so identity must live in the temporary repository rather
        // than only in `git`'s per-command environment.
        git(p, &["config", "user.name", "Test"]);
        git(p, &["config", "user.email", "t@x"]);
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

    fn assert_repo_consistent(dir: &Path) {
        git(dir, &["fsck", "--no-dangling"]);
        assert!(git_out(dir, &["status", "--porcelain"]).is_empty());

        fn collect_locks(path: &Path, locks: &mut Vec<String>) {
            let Ok(entries) = fs::read_dir(path) else {
                return;
            };
            for entry in entries.flatten() {
                let child = entry.path();
                if child.is_dir() {
                    collect_locks(&child, locks);
                } else if child
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(".lock"))
                {
                    locks.push(child.display().to_string());
                }
            }
        }

        let mut locks = Vec::new();
        collect_locks(&dir.join(".git"), &mut locks);
        assert!(locks.is_empty(), "git left lock files behind: {locks:?}");
    }

    fn advance_bare_remote(dir: &TempDir) -> (TempDir, TempDir, String) {
        let remote = TempDir::new().unwrap();
        git(remote.path(), &["init", "--bare"]);
        git(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        git(dir.path(), &["push", "-u", "origin", "main"]);
        git(remote.path(), &["symbolic-ref", "HEAD", "refs/heads/main"]);

        let other = TempDir::new().unwrap();
        git(
            other.path(),
            &["clone", remote.path().to_str().unwrap(), "."],
        );
        git(other.path(), &["config", "user.name", "Test"]);
        git(other.path(), &["config", "user.email", "t@x"]);
        write(other.path(), "remote.txt", "remote\n");
        git(other.path(), &["add", "."]);
        git(other.path(), &["commit", "-m", "remote advance"]);
        git(other.path(), &["push", "origin", "main"]);
        let remote_tip = git_out(other.path(), &["rev-parse", "HEAD"]);
        (remote, other, remote_tip)
    }

    #[test]
    fn network_operation_cancellation_terminates_registered_child() {
        let dir = TempDir::new().unwrap();
        let task_id = 528_001;
        #[cfg(not(windows))]
        let (program, args) = ("sh".to_string(), vec!["-c".into(), "sleep 30".into()]);
        #[cfg(windows)]
        let (program, args) = (
            "powershell.exe".to_string(),
            vec![
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 30".into(),
            ],
        );

        let started = Instant::now();
        let error = tokio_test_block(async {
            let operation = tokio::spawn(run_git_network_with_program(
                dir.path().to_string_lossy().into_owned(),
                args,
                task_id,
                program,
            ));
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel_git_network_operation(task_id).await.unwrap();
            operation.await.unwrap()
        })
        .expect_err("cancelling the registered operation must reject its command");

        assert!(error
            .to_string()
            .contains("git network operation cancelled"));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancel did not terminate the network child promptly"
        );
    }

    #[test]
    fn network_operations_fetch_pull_and_push_observe_pre_cancel() {
        let (dir, _commits) = linear_repo();
        let repo = repo_path(&dir);

        tokio_test_block(async {
            cancel_git_network_operation(528_010).await.unwrap();
            let fetch = git_fetch(repo.clone(), 528_010).await.unwrap_err();
            assert!(fetch
                .to_string()
                .contains("git network operation cancelled"));

            cancel_git_network_operation(528_011).await.unwrap();
            let pull = git_pull(repo.clone(), 528_011).await.unwrap_err();
            assert!(pull.to_string().contains("git network operation cancelled"));

            cancel_git_network_operation(528_012).await.unwrap();
            let push = git_delete_remote_branch(repo, "origin".into(), "topic".into(), 528_012)
                .await
                .unwrap_err();
            assert!(push.to_string().contains("git network operation cancelled"));
        });
    }

    #[test]
    fn network_operation_fetch_cancel_after_ref_commit_preserves_repository() {
        let (dir, _commits) = linear_repo();
        let (_remote, _other, remote_tip) = advance_bare_remote(&dir);
        let repo = repo_path(&dir);
        let before_head = git_out(dir.path(), &["rev-parse", "HEAD"]);
        let cancelled = AtomicBool::new(false);

        let error = run_git_network_sync_after_output(
            &repo,
            &["fetch", "--atomic", "origin"],
            &cancelled,
            "git",
            NETWORK_CANCELLED,
            || cancelled.store(true, Ordering::Relaxed),
        )
        .unwrap_err();

        assert!(error.to_string().contains(NETWORK_CANCELLED));
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/main"]),
            remote_tip
        );
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), before_head);
        assert_repo_consistent(dir.path());
        git(dir.path(), &["fetch", "--atomic", "origin"]);
    }

    #[test]
    fn network_operation_fetches_multiple_remotes_atomically_and_cancels_between_them() {
        let (dir, _commits) = linear_repo();
        let repo = repo_path(&dir);
        let mut remotes = Vec::new();
        let mut clones = Vec::new();
        let mut first_tips = std::collections::HashMap::new();

        for name in ["origin", "backup"] {
            let remote = TempDir::new().unwrap();
            git(remote.path(), &["init", "--bare"]);
            git(
                dir.path(),
                &["remote", "add", name, remote.path().to_str().unwrap()],
            );
            git(dir.path(), &["push", name, "main"]);
            git(remote.path(), &["symbolic-ref", "HEAD", "refs/heads/main"]);

            let clone = TempDir::new().unwrap();
            git(
                clone.path(),
                &["clone", remote.path().to_str().unwrap(), "."],
            );
            git(clone.path(), &["config", "user.name", "Test"]);
            git(clone.path(), &["config", "user.email", "t@x"]);
            write(
                clone.path(),
                &format!("{name}-one.txt"),
                &format!("{name} one\n"),
            );
            git(clone.path(), &["add", "."]);
            git(clone.path(), &["commit", "-m", &format!("{name} one")]);
            git(clone.path(), &["push", "origin", "main"]);
            first_tips.insert(
                name.to_string(),
                git_out(clone.path(), &["rev-parse", "HEAD"]),
            );
            remotes.push(remote);
            clones.push((name.to_string(), clone));
        }

        let cancelled = AtomicBool::new(false);
        let mut completed = Vec::new();
        fetch_all_remotes_sync_with_hook(&repo, &cancelled, |name, _| {
            completed.push(name.to_string());
        })
        .unwrap();
        assert_eq!(completed.len(), 2);
        for name in ["origin", "backup"] {
            assert_eq!(
                git_out(
                    dir.path(),
                    &["rev-parse", &format!("refs/remotes/{name}/main")],
                ),
                first_tips[name]
            );
        }

        let mut second_tips = std::collections::HashMap::new();
        for (name, clone) in &clones {
            write(
                clone.path(),
                &format!("{name}-two.txt"),
                &format!("{name} two\n"),
            );
            git(clone.path(), &["add", "."]);
            git(clone.path(), &["commit", "-m", &format!("{name} two")]);
            git(clone.path(), &["push", "origin", "main"]);
            second_tips.insert(name.clone(), git_out(clone.path(), &["rev-parse", "HEAD"]));
        }

        completed.clear();
        let error = fetch_all_remotes_sync_with_hook(&repo, &cancelled, |name, flag| {
            completed.push(name.to_string());
            if completed.len() == 1 {
                flag.store(true, Ordering::Relaxed);
            }
        })
        .unwrap_err();
        assert!(error.to_string().contains(NETWORK_CANCELLED));
        assert_eq!(completed.len(), 1);

        for name in ["origin", "backup"] {
            let actual = git_out(
                dir.path(),
                &["rev-parse", &format!("refs/remotes/{name}/main")],
            );
            let expected = if completed[0] == name {
                &second_tips[name]
            } else {
                &first_tips[name]
            };
            assert_eq!(&actual, expected);
        }
        assert_repo_consistent(dir.path());

        cancelled.store(false, Ordering::Relaxed);
        fetch_all_remotes_sync_with_hook(&repo, &cancelled, |_, _| {}).unwrap();
        for name in ["origin", "backup"] {
            assert_eq!(
                git_out(
                    dir.path(),
                    &["rev-parse", &format!("refs/remotes/{name}/main")],
                ),
                second_tips[name]
            );
        }
        assert_repo_consistent(dir.path());

        let mut third_tips = std::collections::HashMap::new();
        for (name, clone) in &clones {
            write(
                clone.path(),
                &format!("{name}-three.txt"),
                &format!("{name} three\n"),
            );
            git(clone.path(), &["add", "."]);
            git(clone.path(), &["commit", "-m", &format!("{name} three")]);
            git(clone.path(), &["push", "origin", "main"]);
            third_tips.insert(name.clone(), git_out(clone.path(), &["rev-parse", "HEAD"]));
        }

        git(
            dir.path(),
            &["config", "remote.backup.skipFetchAll", "true"],
        );
        fetch_all_remotes_sync_with_hook(&repo, &cancelled, |_, _| {}).unwrap();
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/main"]),
            third_tips["origin"]
        );
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/backup/main"]),
            second_tips["backup"]
        );

        git(
            dir.path(),
            &["config", "--unset", "remote.backup.skipFetchAll"],
        );
        git(
            dir.path(),
            &["config", "remote.origin.skipDefaultUpdate", "true"],
        );
        fetch_all_remotes_sync_with_hook(&repo, &cancelled, |_, _| {}).unwrap();
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/main"]),
            third_tips["origin"]
        );
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/backup/main"]),
            third_tips["backup"]
        );
        assert_repo_consistent(dir.path());
    }

    #[test]
    fn network_operation_multi_ref_fetch_rejection_is_atomic() {
        let (dir, commits) = linear_repo();
        let repo = repo_path(&dir);
        git(dir.path(), &["branch", "topic"]);

        let remote = TempDir::new().unwrap();
        git(remote.path(), &["init", "--bare"]);
        git(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        git(dir.path(), &["push", "origin", "main", "topic"]);
        git(remote.path(), &["symbolic-ref", "HEAD", "refs/heads/main"]);

        let cancelled = AtomicBool::new(false);
        fetch_all_remotes_sync_with_hook(&repo, &cancelled, |_, _| {}).unwrap();

        let actor = TempDir::new().unwrap();
        git(
            actor.path(),
            &["clone", remote.path().to_str().unwrap(), "."],
        );
        git(actor.path(), &["config", "user.name", "Test"]);
        git(actor.path(), &["config", "user.email", "t@x"]);
        write(actor.path(), "remote-main.txt", "remote main\n");
        git(actor.path(), &["add", "."]);
        git(actor.path(), &["commit", "-m", "advance main"]);
        git(actor.path(), &["push", "origin", "main"]);
        let advanced_main = git_out(actor.path(), &["rev-parse", "HEAD"]);
        git(
            remote.path(),
            &["update-ref", "refs/heads/topic", &commits[0]],
        );
        git(
            dir.path(),
            &[
                "config",
                "--replace-all",
                "remote.origin.fetch",
                "refs/heads/*:refs/remotes/origin/*",
            ],
        );

        let error = fetch_all_remotes_sync_with_hook(&repo, &cancelled, |_, _| {}).unwrap_err();
        assert!(error.to_string().contains("non-fast-forward"));
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/main"]),
            commits[1]
        );
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/topic"]),
            commits[1]
        );
        assert_repo_consistent(dir.path());

        git(
            dir.path(),
            &[
                "config",
                "--replace-all",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        );
        fetch_all_remotes_sync_with_hook(&repo, &cancelled, |_, _| {}).unwrap();
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/main"]),
            advanced_main
        );
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/topic"]),
            commits[0]
        );
        assert_repo_consistent(dir.path());
    }

    #[test]
    fn network_operation_cancels_in_flight_multi_ref_fetch_without_partial_updates() {
        let (dir, commits) = linear_repo();
        let repo = repo_path(&dir);
        git(dir.path(), &["branch", "topic"]);

        let remote = TempDir::new().unwrap();
        let remote_path = remote.path().to_string_lossy().into_owned();
        git(remote.path(), &["init", "--bare"]);
        git(dir.path(), &["remote", "add", "origin", &remote_path]);
        git(dir.path(), &["push", "origin", "main", "topic"]);
        git(remote.path(), &["symbolic-ref", "HEAD", "refs/heads/main"]);

        let cancelled = Arc::new(AtomicBool::new(false));
        fetch_all_remotes_sync_with_hook(&repo, &cancelled, |_, _| {}).unwrap();

        let actor = TempDir::new().unwrap();
        git(actor.path(), &["clone", &remote_path, "."]);
        git(actor.path(), &["config", "user.name", "Test"]);
        git(actor.path(), &["config", "user.email", "t@x"]);
        write(actor.path(), "remote.txt", "remote\n");
        git(actor.path(), &["add", "."]);
        git(actor.path(), &["commit", "-m", "advance both refs"]);
        git(actor.path(), &["push", "origin", "main"]);
        let remote_tip = git_out(actor.path(), &["rev-parse", "HEAD"]);
        git(
            remote.path(),
            &["update-ref", "refs/heads/topic", &remote_tip],
        );

        let marker = dir.path().join(".git/blocking-ssh-started");
        let script = dir.path().join(".git/blocking-ssh.sh");
        let marker_for_shell = marker.to_string_lossy().replace('\\', "/");
        write(
            dir.path(),
            ".git/blocking-ssh.sh",
            &format!("#!/bin/sh\n: > \"{marker_for_shell}\"\nsleep 30\n"),
        );
        let script_for_shell = script.to_string_lossy().replace('\\', "/");
        git(
            dir.path(),
            &[
                "config",
                "core.sshCommand",
                &format!("sh \"{script_for_shell}\""),
            ],
        );
        git(dir.path(), &["config", "ssh.variant", "simple"]);
        git(
            dir.path(),
            &["remote", "set-url", "origin", "example.invalid:repository"],
        );

        let worker_repo = repo.clone();
        let worker_cancelled = Arc::clone(&cancelled);
        let worker = std::thread::spawn(move || {
            fetch_all_remotes_sync_with_hook(&worker_repo, &worker_cancelled, |_, _| {})
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !marker.exists() {
            cancelled.store(true, Ordering::Relaxed);
            let _ = worker.join();
            panic!("fetch never entered the blocking transport");
        }
        let cancel_started = Instant::now();
        cancelled.store(true, Ordering::Relaxed);
        let error = worker.join().unwrap().unwrap_err();
        assert!(error.to_string().contains(NETWORK_CANCELLED));
        assert!(
            cancel_started.elapsed() < Duration::from_secs(5),
            "cancel did not terminate the in-flight multi-ref fetch promptly"
        );
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/main"]),
            commits[1]
        );
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/topic"]),
            commits[1]
        );
        assert_repo_consistent(dir.path());

        cancelled.store(false, Ordering::Relaxed);
        git(dir.path(), &["remote", "set-url", "origin", &remote_path]);
        fetch_all_remotes_sync_with_hook(&repo, &cancelled, |_, _| {}).unwrap();
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/main"]),
            remote_tip
        );
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/topic"]),
            remote_tip
        );
        assert_repo_consistent(dir.path());
    }

    #[test]
    fn network_operation_pull_cancel_boundary_preserves_head_or_returns_undo() {
        let (dir, _commits) = linear_repo();
        let (_remote, _other, remote_tip) = advance_bare_remote(&dir);
        let repo = repo_path(&dir);
        let before_head = git_out(dir.path(), &["rev-parse", "HEAD"]);
        let cancelled = AtomicBool::new(false);

        let error = run_pull_sync_with_hooks(
            &repo,
            &cancelled,
            |flag| flag.store(true, Ordering::Relaxed),
            |_| {},
        )
        .unwrap_err();
        assert!(error.to_string().contains(NETWORK_CANCELLED));
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), before_head);
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/remotes/origin/main"]),
            remote_tip
        );
        assert_repo_consistent(dir.path());

        cancelled.store(false, Ordering::Relaxed);
        let action = run_pull_sync_with_hooks(&repo, &cancelled, |_| {}, |_| {})
            .unwrap()
            .expect("a later pull must return an undo snapshot");
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), remote_tip);
        tokio_test_block(git_undo(repo.clone(), action)).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), before_head);

        cancelled.store(false, Ordering::Relaxed);
        let late_action = run_pull_sync_with_hooks(
            &repo,
            &cancelled,
            |_| {},
            |flag| flag.store(true, Ordering::Relaxed),
        )
        .unwrap()
        .expect("late cancellation must let fast-forward finish with undo");
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), remote_tip);
        tokio_test_block(git_undo(repo, late_action)).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), before_head);
        assert_repo_consistent(dir.path());
    }

    #[test]
    fn network_operation_remote_delete_cancel_reports_applied_outcome_as_uncertain() {
        let (dir, _commits) = linear_repo();
        let repo = repo_path(&dir);
        let remote = TempDir::new().unwrap();
        git(remote.path(), &["init", "--bare"]);
        git(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        git(dir.path(), &["branch", "topic"]);
        git(dir.path(), &["push", "origin", "topic"]);
        git(dir.path(), &["fetch", "origin"]);
        let cancelled = AtomicBool::new(false);

        let error = run_git_network_sync_after_output(
            &repo,
            &["push", "origin", "--delete", "topic"],
            &cancelled,
            "git",
            REMOTE_DELETE_CANCELLED,
            || cancelled.store(true, Ordering::Relaxed),
        )
        .unwrap_err();

        assert_eq!(error.to_string(), REMOTE_DELETE_CANCELLED);
        assert!(git_out(dir.path(), &["ls-remote", "origin", "refs/heads/topic"]).is_empty());
        assert!(!git_out(dir.path(), &["show-ref", "refs/heads/topic"]).is_empty());
        git(dir.path(), &["fetch", "--prune", "origin"]);
        assert!(git_out(dir.path(), &["show-ref", "refs/remotes/origin/topic"]).is_empty());
        assert_repo_consistent(dir.path());
    }

    #[test]
    fn behind_upstream_counts_remote_lead() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        // Local branch "topic" at c1; its "remote" ref at c2 (one ahead).
        git(dir.path(), &["remote", "add", "origin", "."]);
        git(dir.path(), &["branch", "topic", &cs[0]]);
        git(
            dir.path(),
            &["update-ref", "refs/remotes/origin/topic", &cs[1]],
        );
        git(dir.path(), &["config", "branch.topic.remote", "origin"]);
        git(
            dir.path(),
            &["config", "branch.topic.merge", "refs/heads/topic"],
        );

        let behind =
            tokio_test_block(git_branch_behind_upstream(rp.clone(), "topic".into())).unwrap();
        assert_eq!(behind, Some(1));

        // No upstream configured → None.
        git(dir.path(), &["branch", "loner", &cs[0]]);
        let none = tokio_test_block(git_branch_behind_upstream(rp, "loner".into())).unwrap();
        assert_eq!(none, None);
    }

    #[test]
    fn delete_branch_local() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        // Merged branch: safe delete works.
        run_git(&rp, &["branch", "merged", &cs[1]]).unwrap();
        tokio_test_block(git_delete_branch(rp.clone(), "merged".into(), false)).unwrap();
        assert!(git_out(dir.path(), &["branch", "--list", "merged"]).is_empty());

        // Unmerged branch: -d refuses (git's message surfaced), -D deletes.
        git(dir.path(), &["checkout", "-b", "wip", &cs[0]]);
        write(dir.path(), "b.txt", "x\n");
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "wip-only"]);
        git(dir.path(), &["checkout", "main"]);
        let err = tokio_test_block(git_delete_branch(rp.clone(), "wip".into(), false));
        assert!(matches!(err, Err(AppError::Other(m)) if m.contains("not fully merged")));
        tokio_test_block(git_delete_branch(rp.clone(), "wip".into(), true)).unwrap();
        assert!(git_out(dir.path(), &["branch", "--list", "wip"]).is_empty());

        // Checked-out branch: git refuses.
        let err = tokio_test_block(git_delete_branch(rp, "main".into(), true));
        assert!(err.is_err());
    }

    #[test]
    fn git_undo_recreates_deleted_branch_at_exact_tip_and_refuses_recreation() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        git(dir.path(), &["branch", "topic", &cs[0]]);
        let action = tokio_test_block(git_delete_branch(rp.clone(), "topic".into(), true)).unwrap();
        assert!(git_out(dir.path(), &["branch", "--list", "topic"]).is_empty());

        tokio_test_block(git_undo(rp.clone(), action.clone())).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "topic"]), cs[0]);

        git(dir.path(), &["branch", "-D", "topic"]);
        git(dir.path(), &["branch", "topic", &cs[1]]);
        let before = git_out(dir.path(), &["rev-parse", "topic"]);
        let error = tokio_test_block(git_undo(rp, action)).unwrap_err();
        assert!(error.to_string().contains("branch 'topic' already exists"));
        assert_eq!(git_out(dir.path(), &["rev-parse", "topic"]), before);
    }

    #[test]
    fn git_undo_restores_deleted_tag_and_renamed_branch() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        git(dir.path(), &["tag", "v1", &cs[0]]);
        let tag_action = tokio_test_block(git_delete_tag(rp.clone(), "v1".into())).unwrap();
        tokio_test_block(git_undo(rp.clone(), tag_action)).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "v1"]), cs[0]);

        git(dir.path(), &["branch", "before", &cs[0]]);
        let rename_action = tokio_test_block(git_rename_branch(
            rp.clone(),
            "before".into(),
            "after".into(),
        ))
        .unwrap();
        assert!(git_out(dir.path(), &["branch", "--list", "before"]).is_empty());
        tokio_test_block(git_undo(rp, rename_action)).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "before"]), cs[0]);
        assert!(git_out(dir.path(), &["branch", "--list", "after"]).is_empty());
    }

    #[test]
    fn git_undo_restores_the_exact_annotated_tag_object() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        git(dir.path(), &["config", "user.name", "Test"]);
        git(dir.path(), &["config", "user.email", "t@x"]);
        git(
            dir.path(),
            &["tag", "-a", "release", "-m", "release", &cs[0]],
        );
        let tag_object = git_out(dir.path(), &["rev-parse", "refs/tags/release"]);

        let action = tokio_test_block(git_delete_tag(rp.clone(), "release".into())).unwrap();
        tokio_test_block(git_undo(rp, action)).unwrap();

        assert_eq!(
            git_out(dir.path(), &["rev-parse", "refs/tags/release"]),
            tag_object
        );
        assert_eq!(
            git_out(dir.path(), &["cat-file", "-t", "refs/tags/release"]),
            "tag"
        );
    }

    #[test]
    fn git_undo_head_move_requires_unchanged_head_and_clean_tree() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        git(dir.path(), &["branch", "topic", &cs[0]]);
        git(dir.path(), &["checkout", "topic"]);
        let action = GitUndoAction::HeadMove {
            operation: HeadMoveOperation::Merge,
            branch: Some("topic".into()),
            before_oid: cs[0].clone(),
            after_oid: cs[0].clone(),
        };

        write(dir.path(), "dirty.txt", "do not lose\n");
        let error = tokio_test_block(git_undo(rp.clone(), action.clone())).unwrap_err();
        assert!(error.to_string().contains("working tree is not clean"));
        assert!(dir.path().join("dirty.txt").exists());
        fs::remove_file(dir.path().join("dirty.txt")).unwrap();

        git(dir.path(), &["checkout", "main"]);
        let error = tokio_test_block(git_undo(rp, action)).unwrap_err();
        assert!(error.to_string().contains("HEAD moved"));
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), cs[1]);
    }

    #[test]
    fn git_undo_head_transition_refuses_concurrent_ref_and_file_changes() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        write(dir.path(), "newer.txt", "newer\n");
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "newer"]);
        let newer = git_out(dir.path(), &["rev-parse", "HEAD"]);

        let stale_ref = undo_head_move(&rp, Some("main"), &cs[0], &cs[1], || {});
        assert!(stale_ref.is_err(), "composed undo must reject a newer HEAD");
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), newer);

        // Rewind the fixture to the captured post-operation commit. Inject a
        // write at the transaction seam immediately after its ref CAS: the
        // composed undo must refuse, restore HEAD, and preserve the racing edit.
        git(dir.path(), &["reset", "--hard", &cs[1]]);
        let transition = undo_head_move(&rp, Some("main"), &cs[0], &cs[1], || {
            write(dir.path(), "a.txt", "racing local edit\n");
        });
        assert!(
            transition.is_err(),
            "composed undo must refuse a racing worktree edit"
        );
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), cs[1]);
        assert_eq!(
            fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "racing local edit\n"
        );
    }

    #[test]
    fn git_undo_merge_restores_the_pre_merge_head() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        git(dir.path(), &["branch", "feature", &cs[0]]);
        git(dir.path(), &["checkout", "feature"]);
        write(dir.path(), "feature.txt", "feature\n");
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-m", "feature"]);
        git(dir.path(), &["checkout", "main"]);
        let before = git_out(dir.path(), &["rev-parse", "HEAD"]);

        let action = tokio_test_block(git_merge(rp.clone(), "feature".into()))
            .unwrap()
            .expect("merge should move HEAD");
        assert_ne!(git_out(dir.path(), &["rev-parse", "HEAD"]), before);
        tokio_test_block(git_undo(rp, action)).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), before);
    }

    #[test]
    fn git_undo_pull_restores_the_pre_pull_head() {
        let (dir, _cs) = linear_repo();
        let rp = repo_path(&dir);
        let remote = TempDir::new().unwrap();
        git(remote.path(), &["init", "--bare"]);
        git(
            dir.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        git(dir.path(), &["push", "-u", "origin", "main"]);
        git(remote.path(), &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let before = git_out(dir.path(), &["rev-parse", "HEAD"]);

        let other = TempDir::new().unwrap();
        git(
            other.path(),
            &["clone", remote.path().to_str().unwrap(), "."],
        );
        write(other.path(), "remote.txt", "remote\n");
        git(other.path(), &["add", "."]);
        git(other.path(), &["commit", "-m", "remote advance"]);
        git(other.path(), &["push", "origin", "main"]);
        let remote_tip = git_out(other.path(), &["rev-parse", "HEAD"]);

        let action = tokio_test_block(git_pull(rp.clone(), 528_002))
            .unwrap()
            .expect("pull should move HEAD");
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), remote_tip);
        tokio_test_block(git_undo(rp, action)).unwrap();
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), before);
    }

    #[test]
    fn delete_remote_branch_via_push() {
        // "Remote" is a local bare repo; push --delete must remove the ref there.
        let (dir, _cs) = linear_repo();
        let rp = repo_path(&dir);
        let remote_dir = TempDir::new().unwrap();
        git(remote_dir.path(), &["init", "--bare"]);
        git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        );
        git(dir.path(), &["push", "origin", "main:topic"]);
        assert!(!git_out(dir.path(), &["ls-remote", "origin", "refs/heads/topic"]).is_empty());
        tokio_test_block(git_delete_remote_branch(
            rp,
            "origin".into(),
            "topic".into(),
            528_003,
        ))
        .unwrap();
        assert!(git_out(dir.path(), &["ls-remote", "origin", "refs/heads/topic"]).is_empty());
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
    fn stash_apply_keeps_entry_pop_restores_and_drops_it() {
        let (dir, _cs) = linear_repo();
        let rp = repo_path(&dir);
        write(dir.path(), "a.txt", "stashed work\n");
        git(dir.path(), &["stash", "push", "-m", "palette test"]);
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "2\n");
        assert!(git_out(dir.path(), &["stash", "list"]).contains("palette test"));

        tokio_test_block(git_stash_apply(rp.clone(), "stash@{0}".into())).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "stashed work\n"
        );
        assert!(git_out(dir.path(), &["stash", "list"]).contains("palette test"));

        git(dir.path(), &["reset", "--hard"]);
        tokio_test_block(git_stash_pop(rp.clone(), "stash@{0}".into())).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("a.txt")).unwrap(),
            "stashed work\n"
        );
        assert!(git_out(dir.path(), &["stash", "list"]).is_empty());

        assert!(tokio_test_block(git_stash_apply(rp, "stash@{99}".into())).is_err());
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
    fn merge_abort_restores_clean_state() {
        // Build a conflicted merge, then abort it and assert the repo is clean.
        let dir = TempDir::new().unwrap();
        let p = dir.path();
        git(p, &["init", "-b", "main"]);
        git(p, &["config", "commit.gpgsign", "false"]);
        git(p, &["config", "user.name", "Test"]);
        git(p, &["config", "user.email", "t@x"]);
        write(p, "a.txt", "root\n");
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "root"]);
        git(p, &["checkout", "-b", "feature"]);
        write(p, "a.txt", "feature\n");
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "feature"]);
        git(p, &["checkout", "main"]);
        write(p, "a.txt", "main\n");
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "main"]);
        // This merge conflicts and leaves MERGE_HEAD behind.
        let _ = Command::new("git")
            .current_dir(p)
            .args(["merge", "feature"])
            .output()
            .unwrap();
        assert!(
            p.join(".git/MERGE_HEAD").exists(),
            "expected merge in progress"
        );

        run_git(&repo_path(&dir), &["merge", "--abort"]).unwrap();

        // Merge state cleared and the working tree restored to main's content.
        assert!(
            !p.join(".git/MERGE_HEAD").exists(),
            "MERGE_HEAD should be gone"
        );
        assert_eq!(fs::read_to_string(p.join("a.txt")).unwrap(), "main\n");
        // A porcelain status is empty (clean tree).
        assert!(git_out(p, &["status", "--porcelain"]).is_empty());
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

    #[test]
    fn checkout_tracking_creates_local_branch_tracking_remote() {
        // Bare "remote" with a `feature` branch; clone-like setup via fetch.
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        let remote_dir = TempDir::new().unwrap();
        git(remote_dir.path(), &["init", "--bare"]);
        git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        );
        git(dir.path(), &["push", "origin", "main:feature"]);
        // Drop the local `feature` (only the remote ref should exist) & re-fetch.
        git(dir.path(), &["fetch", "origin"]);

        // No local `feature` yet → tracking checkout creates one at origin/feature.
        tokio_test_block(git_checkout_tracking(
            rp.clone(),
            "origin".into(),
            "feature".into(),
        ))
        .unwrap();
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "--abbrev-ref", "HEAD"]),
            "feature"
        );
        assert_eq!(git_out(dir.path(), &["rev-parse", "feature"]), cs[1]);
        // Upstream is configured.
        assert_eq!(
            git_out(
                dir.path(),
                &["rev-parse", "--abbrev-ref", "feature@{upstream}"]
            ),
            "origin/feature"
        );

        // Second call with the local now present → plain checkout, no error.
        git(dir.path(), &["checkout", "main"]);
        tokio_test_block(git_checkout_tracking(rp, "origin".into(), "feature".into())).unwrap();
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "--abbrev-ref", "HEAD"]),
            "feature"
        );
    }

    /// Point a configured upstream `refs/remotes/origin/<branch>` at `oid` and
    /// wire `branch.<branch>.{remote,merge}` so git2's `branch.upstream()` resolves.
    fn set_upstream(dir: &Path, branch: &str, oid: &str) {
        git(
            dir,
            &["update-ref", &format!("refs/remotes/origin/{branch}"), oid],
        );
        git(
            dir,
            &["config", &format!("branch.{branch}.remote"), "origin"],
        );
        git(
            dir,
            &[
                "config",
                &format!("branch.{branch}.merge"),
                &format!("refs/heads/{branch}"),
            ],
        );
    }

    #[test]
    fn sync_fast_forwards_behind_non_current_branch() {
        let (dir, cs) = linear_repo(); // main at c2 (HEAD)
        let rp = repo_path(&dir);
        git(dir.path(), &["remote", "add", "origin", "."]);
        // `topic` at c1, upstream origin/topic at c2 → behind 1, ahead 0.
        git(dir.path(), &["branch", "topic", &cs[0]]);
        set_upstream(dir.path(), "topic", &cs[1]);
        // A branch with no upstream must be left completely alone.
        git(dir.path(), &["branch", "loner", &cs[0]]);

        let res = tokio_test_block(git_sync_local_branches(rp)).unwrap();
        assert_eq!(res.fast_forwarded, vec!["topic".to_string()]);
        assert!(res.diverged.is_empty());
        // topic advanced to c2; loner untouched; HEAD (main) unmoved.
        assert_eq!(git_out(dir.path(), &["rev-parse", "topic"]), cs[1]);
        assert_eq!(git_out(dir.path(), &["rev-parse", "loner"]), cs[0]);
        assert_eq!(git_out(dir.path(), &["rev-parse", "HEAD"]), cs[1]);
    }

    #[test]
    fn sync_reports_diverged_and_leaves_it_untouched() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        let p = dir.path();
        git(p, &["remote", "add", "origin", "."]);
        // `topic` off c1 with its own unique commit (ahead 1).
        git(p, &["checkout", "-b", "topic", &cs[0]]);
        write(p, "t.txt", "topic\n");
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "topic work"]);
        let topic_tip = git_out(p, &["rev-parse", "HEAD"]);
        // A sibling commit off c1 becomes the remote tip (behind 1 too).
        git(p, &["checkout", "-b", "tmp", &cs[0]]);
        write(p, "r.txt", "remote\n");
        git(p, &["add", "."]);
        git(p, &["commit", "-m", "remote work"]);
        let remote_tip = git_out(p, &["rev-parse", "HEAD"]);
        git(p, &["checkout", "main"]);
        git(p, &["branch", "-D", "tmp"]);
        set_upstream(p, "topic", &remote_tip);

        let res = tokio_test_block(git_sync_local_branches(rp)).unwrap();
        assert_eq!(res.diverged, vec!["topic".to_string()]);
        assert!(res.fast_forwarded.is_empty());
        // topic is untouched (still at its own tip).
        assert_eq!(git_out(p, &["rev-parse", "topic"]), topic_tip);
    }

    #[test]
    fn sync_fast_forwards_current_branch_when_clean() {
        let (dir, cs) = linear_repo(); // main HEAD at c2
        let rp = repo_path(&dir);
        let p = dir.path();
        git(p, &["remote", "add", "origin", "."]);
        // Move main back to c1, set its upstream to c2 → behind 1 while checked out.
        git(p, &["reset", "--hard", &cs[0]]);
        set_upstream(p, "main", &cs[1]);

        let res = tokio_test_block(git_sync_local_branches(rp)).unwrap();
        assert_eq!(res.fast_forwarded, vec!["main".to_string()]);
        // Clean tree → merge --ff-only advanced HEAD to c2.
        assert_eq!(git_out(p, &["rev-parse", "HEAD"]), cs[1]);
    }

    #[test]
    fn sync_skips_dirty_current_branch() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        let p = dir.path();
        git(p, &["remote", "add", "origin", "."]);
        git(p, &["reset", "--hard", &cs[0]]);
        set_upstream(p, "main", &cs[1]);
        // Dirty the tree so the checked-out branch must be skipped, not forced.
        write(p, "a.txt", "uncommitted edit\n");

        let res = tokio_test_block(git_sync_local_branches(rp)).unwrap();
        assert!(res.fast_forwarded.is_empty());
        assert_eq!(res.skipped, vec!["main".to_string()]);
        assert_eq!(git_out(p, &["rev-parse", "HEAD"]), cs[0]);
    }

    // ── #432 adversarial verification (verify/432-repro) ────────────────────
    // Attack git_checkout_tracking's claim that it "behaves" on hard inputs:
    // slashed branch names, an existing local whose tip differs from the remote
    // (must NOT be clobbered), and a detached-HEAD starting state.

    /// A tracking checkout of a slash-containing branch name (feat/x/y) must
    /// create the local branch at the remote tip with the right upstream —
    /// slashes are legal ref components and must survive `-b`/`--track`.
    #[test]
    fn checkout_tracking_handles_slashed_branch_name() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        let remote_dir = TempDir::new().unwrap();
        git(remote_dir.path(), &["init", "--bare"]);
        git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        );
        // Remote-only branch with slashes; only refs/remotes/origin/feat/x/y exists locally.
        git(dir.path(), &["push", "origin", "main:feat/x/y"]);
        git(dir.path(), &["fetch", "origin"]);

        tokio_test_block(git_checkout_tracking(
            rp,
            "origin".into(),
            "feat/x/y".into(),
        ))
        .unwrap();

        assert_eq!(
            git_out(dir.path(), &["rev-parse", "--abbrev-ref", "HEAD"]),
            "feat/x/y"
        );
        assert_eq!(git_out(dir.path(), &["rev-parse", "feat/x/y"]), cs[1]);
        assert_eq!(
            git_out(
                dir.path(),
                &["rev-parse", "--abbrev-ref", "feat/x/y@{upstream}"]
            ),
            "origin/feat/x/y"
        );
    }

    /// A local branch with the same name but a DIFFERENT tip than the remote
    /// must be plainly checked out — never fast-forwarded/clobbered to the
    /// remote's tip. This is the data-loss attack: the fix branches on
    /// `local_exists` and must take the plain-checkout path.
    #[test]
    fn checkout_tracking_does_not_clobber_existing_local_at_different_tip() {
        let (dir, cs) = linear_repo(); // main @ c2 (HEAD)
        let rp = repo_path(&dir);
        let p = dir.path();
        git(p, &["remote", "add", "origin", "."]);
        // Local `feature` deliberately at c1 …
        git(p, &["branch", "feature", &cs[0]]);
        // … while the remote-tracking ref points at c2 (a different tip).
        git(p, &["update-ref", "refs/remotes/origin/feature", &cs[1]]);

        tokio_test_block(git_checkout_tracking(rp, "origin".into(), "feature".into())).unwrap();

        // HEAD is on the local branch, and its tip is UNTOUCHED (still c1).
        assert_eq!(
            git_out(p, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "feature"
        );
        assert_eq!(
            git_out(p, &["rev-parse", "feature"]),
            cs[0],
            "existing local branch must not be moved to the remote tip"
        );
    }

    /// Starting from a detached HEAD, a tracking checkout must still create and
    /// switch to the local branch (no assumption that HEAD is on a branch).
    #[test]
    fn checkout_tracking_from_detached_head() {
        let (dir, cs) = linear_repo();
        let rp = repo_path(&dir);
        let remote_dir = TempDir::new().unwrap();
        git(remote_dir.path(), &["init", "--bare"]);
        git(
            dir.path(),
            &[
                "remote",
                "add",
                "origin",
                remote_dir.path().to_str().unwrap(),
            ],
        );
        git(dir.path(), &["push", "origin", "main:feature"]);
        git(dir.path(), &["fetch", "origin"]);
        // Detach HEAD onto c1 before the tracking checkout.
        git(dir.path(), &["checkout", "--detach", &cs[0]]);
        assert_eq!(
            git_out(dir.path(), &["rev-parse", "--abbrev-ref", "HEAD"]),
            "HEAD"
        );

        tokio_test_block(git_checkout_tracking(rp, "origin".into(), "feature".into())).unwrap();

        assert_eq!(
            git_out(dir.path(), &["rev-parse", "--abbrev-ref", "HEAD"]),
            "feature"
        );
        assert_eq!(git_out(dir.path(), &["rev-parse", "feature"]), cs[1]);
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
