//! Baseline (recorded 2026-07-12 on the first `cargo bench` run; 12-core
//! Linux dev box, release profile via criterion's default settings):
//!
//!   git_status/collect_status   time: [423.82 µs 424.40 µs 424.97 µs]
//!
//! Re-run `cargo bench` after touching `collect_status` (src/git.rs) or its
//! `classify`/`repo_op_state` helpers and compare against this baseline.

use criterion::{criterion_group, criterion_main, Criterion};
use git2::{Repository, Signature};
use std::fs;
use tauri_explorer_lib::git::collect_status;

/// Build a synthetic repo with a mix of staged, modified, and untracked
/// files, matching the shapes `collect_status` fans out over (git.rs
/// `classify`). Built once and reused across all iterations — the repo is
/// only read from (`repo.statuses`), never mutated by `collect_status`.
fn build_fixture() -> (tempfile::TempDir, Repository) {
    let dir = tempfile::tempdir().expect("create tempdir");
    let repo = Repository::init(dir.path()).expect("init repo");
    let sig = Signature::now("Bench", "bench@example.com").expect("signature");

    // Initial committed files (some later modified, some left untouched).
    for i in 0..20 {
        fs::write(
            dir.path().join(format!("committed_{i:02}.txt")),
            b"initial content",
        )
        .expect("write committed file");
    }
    {
        let mut index = repo.index().expect("index");
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .expect("add all");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        repo.commit(Some("HEAD"), &sig, &sig, "initial commit", &tree, &[])
            .expect("commit");
    }

    // Modify half the committed files (worktree changes, unstaged).
    for i in 0..10 {
        fs::write(
            dir.path().join(format!("committed_{i:02}.txt")),
            b"modified content",
        )
        .expect("modify file");
    }

    // Stage a fresh batch of new files (staged/added).
    for i in 0..10 {
        fs::write(
            dir.path().join(format!("staged_{i:02}.txt")),
            b"staged content",
        )
        .expect("write staged file");
    }
    {
        let mut index = repo.index().expect("index");
        for i in 0..10 {
            index
                .add_path(std::path::Path::new(&format!("staged_{i:02}.txt")))
                .expect("stage file");
        }
        index.write().expect("write index");
    }

    // Leave a batch of untracked files.
    for i in 0..10 {
        fs::write(
            dir.path().join(format!("untracked_{i:02}.txt")),
            b"untracked content",
        )
        .expect("write untracked file");
    }

    (dir, repo)
}

fn bench_git_status(c: &mut Criterion) {
    let (_dir, repo) = build_fixture();

    c.bench_function("git_status/collect_status", |b| {
        b.iter(|| collect_status(std::hint::black_box(&repo)).expect("collect_status"));
    });
}

criterion_group!(benches, bench_git_status);
criterion_main!(benches);
