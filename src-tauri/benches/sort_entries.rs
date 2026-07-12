//! Baseline (recorded 2026-07-12 on the first `cargo bench` run; 12-core
//! Linux dev box, release profile via criterion's default settings):
//!
//!   sort_entries/10k_entries   time: [1.4000 ms 1.4019 ms 1.4039 ms]
//!
//! Re-run `cargo bench` after touching `sort_entries` (src/files/dir_listing.rs)
//! and compare against this baseline.

use criterion::{criterion_group, criterion_main, Criterion};
use tauri_explorer_lib::files::dir_listing::sort_entries;
use tauri_explorer_lib::files::{FileEntry, FileKind};

/// Build 10k synthetic entries, roughly 1-in-5 directories, in an order
/// unrelated to the sort key (so `sort_by_cached_key` does real work each
/// iteration). `sort_entries` sorts in place, so a fresh clone is handed to
/// each iteration rather than mutating a shared fixture.
fn build_fixture(count: usize) -> Vec<FileEntry> {
    (0..count)
        .map(|i| {
            // Interleave case and a non-monotonic numeric suffix so names
            // aren't already sorted, forcing real comparison work.
            let shuffled = (i * 7919) % count;
            let kind = if i % 5 == 0 {
                FileKind::Directory
            } else {
                FileKind::File
            };
            let name = if i % 2 == 0 {
                format!("Entry_{shuffled:05}")
            } else {
                format!("entry_{shuffled:05}")
            };
            FileEntry {
                name: name.clone(),
                path: format!("/bench/{name}"),
                kind,
                size: (shuffled as u64) * 137,
                modified: "2024-01-01T00:00:00Z".to_string(),
                is_symlink: false,
                symlink_target: None,
                is_empty: None,
            }
        })
        .collect()
}

fn bench_sort_entries(c: &mut Criterion) {
    let fixture = build_fixture(10_000);

    c.bench_function("sort_entries/10k_entries", |b| {
        b.iter_batched(
            || fixture.clone(),
            |mut entries| sort_entries(std::hint::black_box(&mut entries)),
            criterion::BatchSize::LargeInput,
        );
    });
}

criterion_group!(benches, bench_sort_entries);
criterion_main!(benches);
