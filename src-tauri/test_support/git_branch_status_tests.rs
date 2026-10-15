//! Temp-repo tests for `git_branch_status` (#1081): real `git` builds each
//! history and the assertions read `classify_branches`, the exact value the
//! `git_branch_statuses` command returns.

use super::*;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "t@x")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "t@x")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Write `contents` to `file` and commit it; returns the new HEAD OID.
fn commit(dir: &Path, file: &str, contents: &str, message: &str) -> String {
    fs::write(dir.join(file), contents).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", message]);
    git(dir, &["rev-parse", "HEAD"])
}

/// A repo on `main` with one base commit.
fn repo() -> TempDir {
    let dir = TempDir::new().unwrap();
    let p = dir.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["config", "user.name", "Test"]);
    git(p, &["config", "user.email", "t@x"]);
    git(p, &["config", "commit.gpgsign", "false"]);
    // Pin the default-branch fallback so host config cannot steer trunk.
    git(p, &["config", "init.defaultBranch", "main"]);
    commit(p, "base.txt", "base\n", "base");
    dir
}

/// Branch `name` off the current HEAD with one or more commits to new files.
fn feature(dir: &Path, name: &str, files: &[(&str, &str)]) {
    git(dir, &["checkout", "-q", "-b", name]);
    for (file, contents) in files {
        commit(dir, file, contents, &format!("{name}: {file}"));
    }
    git(dir, &["checkout", "-q", "main"]);
}

/// Pretend `remote/branch` was fetched at `oid`; optionally make `local`
/// track it.
fn remote_branch(dir: &Path, remote: &str, branch: &str, oid: &str, local: Option<&str>) {
    if git(dir, &["remote"]).lines().all(|line| line != remote) {
        git(
            dir,
            &["remote", "add", remote, "https://example.invalid/repo.git"],
        );
    }
    git(
        dir,
        &[
            "update-ref",
            &format!("refs/remotes/{remote}/{branch}"),
            oid,
        ],
    );
    if let Some(local) = local {
        git(dir, &["config", &format!("branch.{local}.remote"), remote]);
        git(
            dir,
            &[
                "config",
                &format!("branch.{local}.merge"),
                &format!("refs/heads/{branch}"),
            ],
        );
    }
}

fn classify_with(dir: &Path, limits: ClassifyLimits) -> BranchStatuses {
    let repo = Repository::open(dir).unwrap();
    classify_branches(&repo, limits).unwrap()
}

fn classify(dir: &Path) -> BranchStatuses {
    classify_with(dir, DEFAULT_LIMITS)
}

fn status_of(result: &BranchStatuses, name: &str) -> Option<BranchStatus> {
    result
        .statuses
        .iter()
        .find(|entry| entry.name == name)
        .map(|entry| entry.status)
}

#[test]
fn ordinary_merge_commit_is_merged() {
    let dir = repo();
    let p = dir.path();
    feature(p, "feature", &[("a.txt", "a\n")]);
    commit(p, "main.txt", "main\n", "main moves on");
    git(
        p,
        &["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"],
    );

    let result = classify(p);
    assert_eq!(result.trunk.as_deref(), Some("main"));
    assert_eq!(status_of(&result, "feature"), Some(BranchStatus::Merged));
}

#[test]
fn squash_merge_is_squash_merged() {
    let dir = repo();
    let p = dir.path();
    feature(p, "feature", &[("a.txt", "a\n"), ("b.txt", "b\n")]);
    commit(p, "main.txt", "main\n", "main moves on");
    git(p, &["merge", "-q", "--squash", "feature"]);
    git(p, &["commit", "-q", "-m", "Squashed feature"]);
    commit(p, "later.txt", "later\n", "later trunk work");

    assert_eq!(
        status_of(&classify(p), "feature"),
        Some(BranchStatus::SquashMerged)
    );
}

#[test]
fn partial_squash_gets_no_status() {
    let dir = repo();
    let p = dir.path();
    feature(p, "feature", &[("a.txt", "a\n"), ("b.txt", "b\n")]);
    // Land only a.txt's half of the branch on trunk as one commit.
    git(p, &["checkout", "-q", "feature", "--", "a.txt"]);
    git(p, &["commit", "-q", "-m", "Part of feature"]);

    assert_eq!(status_of(&classify(p), "feature"), None);
}

#[test]
fn unmerged_unique_commits_get_no_status() {
    let dir = repo();
    let p = dir.path();
    feature(p, "feature", &[("a.txt", "a\n")]);
    commit(p, "main.txt", "main\n", "main moves on");

    assert!(classify(p).statuses.is_empty());
}

#[test]
fn tip_on_trunk_first_parent_chain_is_not_merged() {
    let dir = repo();
    let p = dir.path();
    // Freshly created from main, then main moves on: merely behind trunk.
    git(p, &["branch", "fresh"]);
    commit(p, "one.txt", "1\n", "one");
    git(p, &["branch", "behind"]);
    commit(p, "two.txt", "2\n", "two");
    git(p, &["branch", "at-trunk"]);

    let result = classify(p);
    assert_eq!(status_of(&result, "fresh"), None);
    assert_eq!(status_of(&result, "behind"), None);
    assert_eq!(status_of(&result, "at-trunk"), None);
}

#[test]
fn local_behind_upstream_is_stale_not_merged() {
    let dir = repo();
    let p = dir.path();
    git(p, &["checkout", "-q", "-b", "feature"]);
    let older = commit(p, "a.txt", "a\n", "feature 1");
    let newer = commit(p, "a.txt", "a2\n", "feature 2");
    git(p, &["checkout", "-q", "main"]);
    // Merge so that, ignoring the upstream, the old tip would read merged.
    git(
        p,
        &["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"],
    );
    git(p, &["branch", "-f", "feature", &older]);
    remote_branch(p, "origin", "feature", &newer, Some("feature"));

    let result = classify(p);
    assert_eq!(status_of(&result, "feature"), Some(BranchStatus::Stale));
}

#[test]
fn remote_behind_local_is_stale() {
    let dir = repo();
    let p = dir.path();
    git(p, &["checkout", "-q", "-b", "feature"]);
    let older = commit(p, "a.txt", "a\n", "feature 1");
    commit(p, "a.txt", "a2\n", "feature 2");
    git(p, &["checkout", "-q", "main"]);
    remote_branch(p, "origin", "feature", &older, Some("feature"));

    let result = classify(p);
    assert_eq!(
        status_of(&result, "origin/feature"),
        Some(BranchStatus::Stale)
    );
    assert_eq!(status_of(&result, "feature"), None);
}

#[test]
fn diverged_from_upstream_is_not_stale() {
    let dir = repo();
    let p = dir.path();
    git(p, &["checkout", "-q", "-b", "feature"]);
    commit(p, "a.txt", "a\n", "shared");
    git(p, &["checkout", "-q", "-b", "elsewhere"]);
    let theirs = commit(p, "b.txt", "theirs\n", "theirs");
    git(p, &["checkout", "-q", "feature"]);
    commit(p, "c.txt", "ours\n", "ours");
    git(p, &["checkout", "-q", "main"]);
    git(p, &["branch", "-D", "elsewhere"]);
    remote_branch(p, "origin", "feature", &theirs, Some("feature"));

    let result = classify(p);
    assert_eq!(status_of(&result, "feature"), None);
    assert_eq!(status_of(&result, "origin/feature"), None);
}

#[test]
fn main_master_and_trunk_are_never_merged() {
    let dir = repo();
    let p = dir.path();
    // `master` and `origin/develop` both merged into main via merge commits.
    feature(p, "master", &[("m.txt", "m\n")]);
    git(
        p,
        &["merge", "-q", "--no-ff", "-m", "Merge master", "master"],
    );
    feature(p, "develop", &[("d.txt", "d\n")]);
    let develop = git(p, &["rev-parse", "develop"]);
    git(
        p,
        &["merge", "-q", "--no-ff", "-m", "Merge develop", "develop"],
    );
    // origin/main is the trunk counterpart sitting on a merged side commit.
    remote_branch(p, "origin", "main", &develop, None);
    remote_branch(p, "origin", "master", &develop, None);

    let result = classify(p);
    assert_eq!(result.trunk.as_deref(), Some("main"));
    assert_eq!(status_of(&result, "main"), None);
    assert_eq!(status_of(&result, "master"), None);
    assert_eq!(status_of(&result, "origin/main"), None);
    assert_eq!(status_of(&result, "origin/master"), None);
    // The control: an ordinary merged branch still classifies.
    assert_eq!(status_of(&result, "develop"), Some(BranchStatus::Merged));
}

#[test]
fn remote_head_wins_and_its_branch_is_protected() {
    let dir = repo();
    let p = dir.path();
    feature(p, "develop", &[("d.txt", "d\n")]);
    let develop = git(p, &["rev-parse", "develop"]);
    feature(p, "topic", &[("t.txt", "t\n")]);
    // Trunk is origin/develop: topic merged into it, local develop on it.
    git(p, &["checkout", "-q", "develop"]);
    git(p, &["merge", "-q", "--no-ff", "-m", "Merge topic", "topic"]);
    let merged = git(p, &["rev-parse", "HEAD"]);
    git(p, &["reset", "-q", "--hard", &develop]);
    git(p, &["checkout", "-q", "main"]);
    remote_branch(p, "origin", "develop", &merged, None);
    git(
        p,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/develop",
        ],
    );

    let result = classify(p);
    assert_eq!(result.trunk.as_deref(), Some("origin/develop"));
    assert_eq!(status_of(&result, "topic"), Some(BranchStatus::Merged));
    assert_eq!(status_of(&result, "develop"), None);
    assert_eq!(status_of(&result, "origin/develop"), None);
}

#[test]
fn init_default_branch_precedes_main() {
    let dir = repo();
    let p = dir.path();
    git(p, &["branch", "trunk"]);
    git(p, &["config", "init.defaultBranch", "trunk"]);
    assert_eq!(classify(p).trunk.as_deref(), Some("trunk"));
}

#[test]
fn checked_out_feature_does_not_change_classification() {
    let dir = repo();
    let p = dir.path();
    feature(p, "merged", &[("a.txt", "a\n")]);
    git(
        p,
        &["merge", "-q", "--no-ff", "-m", "Merge merged", "merged"],
    );
    feature(p, "squashed", &[("b.txt", "b\n")]);
    git(p, &["merge", "-q", "--squash", "squashed"]);
    git(p, &["commit", "-q", "-m", "Squash"]);
    feature(p, "open", &[("c.txt", "c\n")]);

    let on_main = classify(p);
    git(p, &["checkout", "-q", "open"]);
    let on_feature = classify(p);
    assert_eq!(on_main, on_feature);
    assert_eq!(on_feature.trunk.as_deref(), Some("main"));
    assert_eq!(status_of(&on_feature, "merged"), Some(BranchStatus::Merged));
    assert_eq!(
        status_of(&on_feature, "squashed"),
        Some(BranchStatus::SquashMerged)
    );
    assert_eq!(status_of(&on_feature, "open"), None);
}

#[test]
fn unresolved_trunk_reports_nothing() {
    let dir = TempDir::new().unwrap();
    let p = dir.path();
    git(p, &["init", "-q", "-b", "work"]);
    git(p, &["config", "user.name", "Test"]);
    git(p, &["config", "user.email", "t@x"]);
    git(p, &["config", "commit.gpgsign", "false"]);
    git(p, &["config", "init.defaultBranch", "absent"]);
    let older = commit(p, "a.txt", "a\n", "one");
    let newer = commit(p, "a.txt", "b\n", "two");
    git(p, &["branch", "-f", "lagging", &older]);
    // Would be stale against its upstream if a trunk resolved.
    remote_branch(p, "origin", "lagging", &newer, Some("lagging"));

    let result = classify(p);
    assert_eq!(result, BranchStatuses::default());
}

#[test]
fn exhausted_squash_search_is_unknown() {
    let dir = repo();
    let p = dir.path();
    feature(p, "feature", &[("a.txt", "a\n")]);
    git(p, &["merge", "-q", "--squash", "feature"]);
    git(p, &["commit", "-q", "-m", "Squashed feature"]);
    commit(p, "x.txt", "x\n", "after 1");
    commit(p, "y.txt", "y\n", "after 2");

    let limits = ClassifyLimits {
        first_parent: DEFAULT_LIMITS.first_parent,
        squash: 2,
    };
    assert_eq!(
        status_of(&classify_with(p, limits), "feature"),
        Some(BranchStatus::Unknown)
    );
    // With room to reach the squash commit the verdict is positive.
    let limits = ClassifyLimits {
        squash: 3,
        ..limits
    };
    assert_eq!(
        status_of(&classify_with(p, limits), "feature"),
        Some(BranchStatus::SquashMerged)
    );
}

#[test]
fn exhausted_first_parent_search_is_unknown() {
    let dir = repo();
    let p = dir.path();
    git(p, &["branch", "old"]);
    commit(p, "x.txt", "x\n", "after 1");
    commit(p, "y.txt", "y\n", "after 2");

    let limits = ClassifyLimits {
        first_parent: 1,
        squash: DEFAULT_LIMITS.squash,
    };
    // `old` is on trunk's line, but beyond the walk: never positive.
    assert_eq!(
        status_of(&classify_with(p, limits), "old"),
        Some(BranchStatus::Unknown)
    );
    assert_eq!(status_of(&classify(p), "old"), None);
}
