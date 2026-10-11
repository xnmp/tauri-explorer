//! Actual subprocess contract tests; no network or global PATH mutation.
use super::*;
use std::os::unix::fs::PermissionsExt;

fn fixture() -> (tempfile::TempDir, String, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    let repo = git2::Repository::init(&root).unwrap();
    repo.remote("origin", "https://github.com/action-tests/example.git").unwrap();
    let tree_id = repo.index().unwrap().write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = git2::Signature::now("Test", "test@example.com").unwrap();
    repo.commit(Some("refs/heads/feature"), &sig, &sig, "initial", &tree, &[]).unwrap();
    repo.set_head("refs/heads/feature").unwrap();
    let executable = dir.path().join("fake-gh");
    std::fs::write(&executable, "#!/bin/sh\nprintf '%s\\n' \"$@\" > argv\npwd > cwd\nprintf 'https://github.com/action-tests/example/pull/9\\n'\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    (dir, root, executable)
}
fn create(head: &str) -> PrAction {
    PrAction::Create { head_branch: head.into(), title: "Title $(touch injected)".into(), body: "First\nSecond".into(), base: "dev".into() }
}
fn argv(root: &str) -> Vec<String> {
    std::fs::read_to_string(Path::new(root).join("argv")).unwrap().lines().map(String::from).collect()
}
#[test]
fn pr_actions_create_runs_gh_in_repo_and_returns_url() {
    let (_dir, root, exe) = fixture();
    let output = execute_pr_action(&root, create("feature"), &exe).unwrap();
    assert_eq!(output, "https://github.com/action-tests/example/pull/9");
    assert_eq!(argv(&root), vec!["pr", "create", "--repo", "action-tests/example", "--head", "feature", "--base", "dev", "--title", "Title $(touch injected)", "--body", "First", "Second"]);
    assert_eq!(std::fs::read_to_string(Path::new(&root).join("cwd")).unwrap().trim(), root);
    assert!(!Path::new(&root).join("injected").exists());
}
#[test]
fn pr_actions_merge_and_approve_use_explicit_repo_and_number() {
    let (_dir, root, exe) = fixture();
    for (method, flag) in [(PrMergeMethod::Merge, "--merge"), (PrMergeMethod::Squash, "--squash"), (PrMergeMethod::Rebase, "--rebase")] {
        execute_pr_action(&root, PrAction::Merge { pr_number: 9, method }, &exe).unwrap();
        assert_eq!(argv(&root), ["pr", "merge", "9", "--repo", "action-tests/example", flag]);
    }
    execute_pr_action(&root, PrAction::Approve { pr_number: 9 }, &exe).unwrap();
    assert_eq!(argv(&root), ["pr", "review", "9", "--repo", "action-tests/example", "--approve"]);
}
#[test]
fn pr_actions_refuse_stale_or_detached_head_before_spawning() {
    let (_dir, root, exe) = fixture();
    assert!(execute_pr_action(&root, create("other"), &exe).unwrap_err().to_string().contains("branch"));
    let repo = git2::Repository::open(&root).unwrap();
    repo.set_head_detached(repo.head().unwrap().target().unwrap()).unwrap();
    assert!(execute_pr_action(&root, create("feature"), &exe).is_err());
    assert!(!Path::new(&root).join("argv").exists());
}
#[test]
fn pr_actions_cli_errors_are_not_success_and_clear_stale_badges() {
    let (_dir, root, exe) = fixture();
    std::fs::write(&exe, "#!/bin/sh\necho 'authentication required' >&2\nexit 1\n").unwrap();
    cache_put("action-tests/example".into(), CacheState::Hit(vec![]));
    assert!(execute_pr_action(&root, create("feature"), &exe).unwrap_err().to_string().contains("authentication required"));
    assert!(cache_get("action-tests/example").is_none());
}
#[test]
fn pr_actions_success_invalidates_badges_and_missing_cli_is_actionable() {
    let (_dir, root, exe) = fixture();
    cache_put("action-tests/example".into(), CacheState::Hit(vec![]));
    execute_pr_action(&root, create("feature"), &exe).unwrap();
    assert!(cache_get("action-tests/example").is_none());
    assert!(execute_pr_action(&root, create("feature"), &Path::new(&root).join("absent-gh")).unwrap_err().to_string().contains("not installed"));
}
