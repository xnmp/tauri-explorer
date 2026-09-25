# Arch startup qualification — 2026-09-23

The complete-snapshot directory path reduces large-directory launch time on this
Arch machine. It does not materially improve a small directory. This qualifies
Linux application readiness, not macOS Dock animation or compositor presentation.

## Results

Twenty measured fresh-process launches per cell, plus two excluded warmups.
Baseline and candidate alternate AB/BA within each directory size. Times include
process launch through receipt of the native foreground-ready marker.

| Files | Baseline p50 / p95 | Snapshot p50 / p95 | Median change |
| ---: | ---: | ---: | ---: |
| 0 | 353.6 / 371.6 ms | 358.3 / 376.4 ms | +1.3% |
| 100 | 392.4 / 407.3 ms | 391.1 / 408.3 ms | -0.3% |
| 10,000 | 524.8 / 549.9 ms | 434.7 / 451.6 ms | -17.2% |
| 100,000 | 2,110.4 / 2,222.5 ms | 882.6 / 947.2 ms | -58.2% |

The candidate was faster in all 20 paired runs at both larger sizes. Independent
review recomputed the figures from all 176 raw logs, checked exact entry counts,
completed baseline streams, binary hashes and build provenance. Percentiles use
nearest rank (sorted sample indices 9 and 18).

## Change and provenance

Baseline: `9ca896d5fcf50b40974dde499e4e703b33210538`.
Candidate: `822f8751d77cb91eeef9863310b2d9bcde94de00`, with no tracked build-time diff.
Binary hashes, phase samples, environment and interaction runs are retained in
[the machine-readable report](arch-startup-822f8751.json).

The old backend scanned and sorted the entire directory before returning 100
entries, then broadcast the rest in 100-entry batches with a 1 ms pause between
batches. Fresh navigation kept the list hidden until completion. The new command
returns the complete fresh snapshot once. Cached readers retain their separate
cached command. The frontend retains latest-request ownership, serialized scans,
watch-before-scan observation and disposal of rejected or late watch leases.

Builds use `cargo build --release --locked --features tauri/custom-protocol`,
production frontend assets, no E2E hooks and default recovery features. Hardware:
Ryzen 9 5900X; Arch kernel 7.1.5; Xvfb/Openbox, X11, 1200×800. Settings:
`warmWindow: false`, Details view, other defaults. Each case has an isolated app
profile. OS caches are uncontrolled and warmed: this is not cold-disk testing.
No other builds or tests from this session ran during the measurements.

The endpoint follows settings, command registration, initial listing and two
animation-frame opportunities. It does not observe compositor-presented pixels
or exercise input during startup. An external monotonic receipt cross-check
lagged the native epoch receipt by 0.05–10.06 ms. These numbers do not establish
normal Wayland launch performance or the macOS half-bounce target.

## Separate native interaction qualification

Three baseline/candidate pairs opened 100,000 real files and required the full
status-bar count plus native Ctrl+End selection of the final virtualized row.
All six passed. The [candidate screenshot](../../screenshots/fix/macos-cold-startup/arch-100000-last-entry.png)
shows `100000 items` and selected, visible `file-99999.txt`.

The first DOM entries appeared only with the complete result: baseline
1,767–1,862 ms; candidate 650–683 ms, measured from in-app navigation. Keyboard
WebDriver round trips were 149–174 ms versus 153–176 ms; these include driver
latency and are not pure input latency. Maximum rAF gaps were 409–719 ms versus
470–506 ms: the change does not establish smoother frames. Large-directory main
thread stalls remain tracked in [#737](https://github.com/xnmp/tauri-explorer/issues/737). Peak summed process RSS was
1.64–1.66 GB versus 1.33–1.36 GB; shared mappings are double-counted, so this is
not proportional memory usage.

Interaction uses the matching WebKitGTK 4.1 driver on isolated ports. The release
launcher's detach fork prevents WebDriver session creation on this setup. A
test-only preload shim bypasses the first fork of the exact application
executable for these interaction runs only. Startup timings above use the
unmodified release launch path, without the shim.

## Regression coverage and limits

- Full frontend unit suite: 2,500 passed, three skipped.
- Rust directory contracts: 17 passed, including a real 10,003-entry fresh listing.
- Performance contracts: 29 passed.
- Frontend/native type checks, strict Rust library Clippy, architecture lint and source-map coverage pass.
- Affected Chromium navigation, selection and pane lifecycle: 84 passed across Details, List and Tiles.
- Native debug/custom-protocol watcher handoff, refresh coalescing and listing errors: six passed with real files and watchers.
- Native complete-listing/keyboard and first-search-result contracts: three passed. The initial keyboard assertion wrongly required the dual-pane-only `.active` border class; correcting that test scope made the single-pane check pass. Production source is unchanged from the measured candidate.
- Independent source review found no concrete stale-publication or watch-lease regression.

Filesystem scans and IPC responses already in flight remain non-cancellable.
A slow or unresponsive mount can delay a queued navigation or teardown. This
measurement cannot establish a bound for that workload.

Raw logs, binaries, harnesses and the local compressed evidence bundle are kept
under `/tmp/startup-696-final-ab-mkbq04ib`,
`/tmp/startup-696-final-interaction-z_flekz9`, and
`/tmp/startup-696-final-evidence.tar.gz` on the measurement machine.
