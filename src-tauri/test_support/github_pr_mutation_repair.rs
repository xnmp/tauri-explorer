use super::*;
use std::os::unix::fs::PermissionsExt;

fn fixture() -> (tempfile::TempDir, String, String, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap().to_string();
    let slug = format!("repair-test/{}", dir.path().file_name().unwrap().to_str().unwrap());
    let repo = git2::Repository::init(&root).unwrap();
    repo.remote("origin", &format!("https://github.com/{slug}.git")).unwrap();
    let tree = repo.find_tree(repo.index().unwrap().write_tree().unwrap()).unwrap();
    let sig = git2::Signature::now("Test", "test@example.com").unwrap();
    repo.commit(Some("refs/heads/feature"), &sig, &sig, "initial", &tree, &[]).unwrap();
    repo.set_head("refs/heads/feature").unwrap();
    let exe = dir.path().join("fake-gh");
    std::fs::write(&exe, "#!/bin/sh\nprintf '%s\\0' \"$@\" > argv\necho call >> calls\necho https://github.com/repair-test/example/pull/15\n").unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    (dir, root, slug, exe)
}
fn approval(slug: &str) -> PrAction { PrAction::Approve { repo_slug: slug.into(), pr_number: 15 } }
fn argv(root: &str) -> Vec<String> {
    std::fs::read(Path::new(root).join("argv")).unwrap().split(|b| *b == 0).filter(|arg| !arg.is_empty()).map(|arg| String::from_utf8(arg.to_vec()).unwrap()).collect()
}
#[test]
fn pr_actions_repair_host_is_explicit_for_create_merge_and_approve() {
    let (_dir, root, slug, exe) = fixture();
    for request in [
        PrAction::Create { repo_slug: slug.clone(), head_branch: "feature".into(), title: "Title".into(), body: "Body".into(), base: "dev".into() },
        PrAction::Merge { repo_slug: slug.clone(), pr_number: 15, method: PrMergeMethod::Squash },
        approval(&slug),
    ] {
        execute_pr_action(&root, request, &exe).unwrap();
        let args = argv(&root);
        let repo_flag = args.iter().position(|arg| arg == "--repo").unwrap();
        assert_eq!(args[repo_flag + 1], format!("github.com/{slug}"));
    }
}
#[test]
fn pr_actions_repair_other_windows_are_refused_until_child_is_reaped() {
    let (_dir, root, slug, exe) = fixture();
    std::fs::write(&exe, "#!/bin/sh\necho call >> calls\ntouch started\nwhile [ ! -f release ]; do sleep 0.02; done\necho done\n").unwrap();
    let worker_root = root.clone(); let worker_slug = slug.clone(); let worker_exe = exe.clone();
    let first = std::thread::spawn(move || execute_pr_action(&worker_root, approval(&worker_slug), &worker_exe));
    let deadline = Instant::now() + Duration::from_secs(10);
    while !Path::new(&root).join("started").exists() {
        assert!(Instant::now() < deadline, "first subprocess never started");
        std::thread::sleep(Duration::from_millis(10));
    }
    let (_other_dir, other_root, _, other_exe) = fixture();
    git2::Repository::open(&other_root).unwrap().remote_set_url("origin", &format!("https://github.com/{slug}.git")).unwrap();
    let refused = execute_pr_action(&other_root, approval(&slug), &other_exe).unwrap_err();
    assert!(refused.to_string().contains("already running"));
    assert!(!Path::new(&other_root).join("calls").exists());
    std::fs::write(Path::new(&root).join("release"), "").unwrap();
    first.join().unwrap().unwrap();
    assert_eq!(std::fs::read_to_string(Path::new(&root).join("calls")).unwrap(), "call\n");
    execute_pr_action(&other_root, approval(&slug), &other_exe).unwrap();
}
#[test]
fn pr_actions_repair_accepted_then_lost_ack_is_uncertain_and_never_replayed() {
    let (_dir, root, slug, exe) = fixture();
    std::fs::write(&exe, "#!/bin/sh\necho approved >> accepted\necho 'connection lost after remote acceptance' >&2\nexit 9\n").unwrap();
    cache_put_if_current(slug.clone(), CacheState::Hit(vec![]), PR_CACHE_REVISION.load(Ordering::Relaxed));
    let error = execute_pr_action(&root, approval(&slug), &exe).unwrap_err();
    assert_eq!(serde_json::to_value(&error).unwrap()["kind"], "pr_mutation_uncertain");
    assert!(error.to_string().contains("GitHub may have applied"));
    assert_eq!(std::fs::read_to_string(Path::new(&root).join("accepted")).unwrap(), "approved\n");
    assert!(cache_get(&slug).is_none());
}
