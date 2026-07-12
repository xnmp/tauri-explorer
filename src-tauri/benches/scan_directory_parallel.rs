//! Baseline (recorded on first `cargo bench` run, 12-core Linux dev box,
//! release profile via criterion's default settings):
//!
//!   scan_directory_parallel/10k_files   time: [~24.8 ms 25.4 ms 26.1 ms]
//!
//! Re-run `cargo bench` after touching `scan_directory_parallel` or
//! `sort_entries` (src/files/dir_listing.rs) and compare against this
//! baseline — criterion also prints its own historical comparison from
//! `target/criterion/`.

use criterion::{criterion_group, criterion_main, Criterion};
use std::fs;
use std::path::PathBuf;
use tauri_explorer_lib::files::dir_listing::scan_directory_parallel;

/// Build a flat directory of 10k small files once, reused across all
/// iterations (jwalk + rayon calls are read-only, so no per-iteration
/// filesystem mutation is needed).
fn build_fixture(count: usize) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("create tempdir");
    for i in 0..count {
        let path = dir.path().join(format!("file_{i:05}.txt"));
        fs::write(&path, b"benchmark fixture content").expect("write fixture file");
    }
    dir
}

fn bench_scan_directory_parallel(c: &mut Criterion) {
    let fixture = build_fixture(10_000);
    let dir_path = PathBuf::from(fixture.path());

    c.bench_function("scan_directory_parallel/10k_files", |b| {
        b.iter(|| scan_directory_parallel(std::hint::black_box(&dir_path)));
    });
}

criterion_group!(benches, bench_scan_directory_parallel);
criterion_main!(benches);
