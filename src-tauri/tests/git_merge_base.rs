use git2::{Oid, Repository, Signature};
use tauri_explorer_lib::git_log::git_merge_base;
use tempfile::tempdir;

fn commit(repo: &Repository, parents: &[Oid], message: &str) -> Oid {
    let tree_id = repo.treebuilder(None).unwrap().write().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let sig = Signature::now("Test", "test@example.com").unwrap();
    let parents: Vec<_> = parents.iter().map(|oid| repo.find_commit(*oid).unwrap()).collect();
    repo.commit(None, &sig, &sig, message, &tree, &parents.iter().collect::<Vec<_>>()).unwrap()
}

#[tokio::test]
async fn returns_real_ancestor_for_local_and_remote_branches_without_moving_head() {
    let dir = tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    let root = commit(&repo, &[], "root");
    let fork = commit(&repo, &[root], "fork");
    let mut left = fork;
    for n in 0..600 {
        left = commit(&repo, &[left], &format!("left {n}"));
    }
    let right = commit(&repo, &[fork], "right");
    repo.reference("refs/heads/left", left, true, "test").unwrap();
    repo.reference("refs/heads/right", right, true, "test").unwrap();
    repo.reference("refs/remotes/origin/right", right, true, "test").unwrap();
    // Deliberately ambiguous shorthand: the remote must win when selected.
    repo.reference("refs/heads/origin/right", root, true, "test").unwrap();
    repo.set_head("refs/heads/left").unwrap();
    let path = dir.path().to_string_lossy().to_string();
    for target in ["refs/heads/right", "refs/remotes/origin/right"] {
        assert_eq!(git_merge_base(path.clone(), "refs/heads/left".into(), target.into()).await.unwrap(), Some(fork.to_string()));
    }
    assert_eq!(repo.head().unwrap().target(), Some(left));
    assert_eq!(repo.head().unwrap().name().unwrap(), "refs/heads/left");
    let unrelated = commit(&repo, &[], "unrelated");
    repo.reference("refs/heads/orphan", unrelated, true, "test").unwrap();
    assert_eq!(git_merge_base(path.clone(), "refs/heads/left".into(), "refs/heads/orphan".into()).await.unwrap(), None);
    assert!(git_merge_base(path.clone(), "refs/heads/missing".into(), "refs/heads/left".into()).await.is_err());
    assert!(git_merge_base(path, "HEAD".into(), "refs/heads/left".into()).await.is_err());
}
