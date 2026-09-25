# Arch immutable-listing qualification — 2026-09-23

Keeping directory snapshots outside Svelte's deep proxy machinery reduces large
listing work and startup time. This change builds on the complete-snapshot
startup change in PR #738; it does not change directory/watch ownership.

## Fresh-process startup

Twenty measured launches per cell, two excluded warmups, alternating AB/BA.
The baseline already includes PR #738. Percentiles use nearest rank.

| Files | Snapshot baseline p50 / p95 | Raw revision p50 / p95 |
| ---: | ---: | ---: |
| 100 | 373.2 / 384.3 ms | 367.4 / 389.0 ms |
| 100,000 | 837.4 / 874.1 ms | 625.5 / 658.7 ms |

The 100k p50 improves by 25.3%; the small-directory result is effectively
unchanged. These are fresh application processes with warmed, uncontrolled OS
caches, on Arch/Ryzen 9 5900X using isolated Xvfb/Openbox X11. No builds or tests
from this session ran concurrently. This is not cold-disk or normal Wayland launch
qualification. The endpoint is native receipt after settings, command registration,
initial listing and two animation-frame opportunities, not observed compositor
presentation or an input-response timestamp. No macOS half-bounce claim follows.

## Native Details interaction

Nine paired runs in Details mode on the same 100k fixture:

| Endpoint (median) | Snapshot baseline | Raw revision |
| --- | ---: | ---: |
| Navigation to complete count | 650 ms | 344 ms |
| Maximum rAF gap before complete count | 462 ms | 155 ms |
| Ctrl+End round trip to visible selected final row | 156 ms | 103 ms |

All 18 runs reached the full count and selected final row. A second navigation
started loading the large directory, requested the address editor before the
complete-count frame, typed an empty-directory path with native key events, and
reached that directory. It remained there for the bounded 500 ms observation.
This tests the input outcome during an outstanding load; it does not prove
input preempted a blocking task or establish pure keystroke latency. WebDriver
round trips include driver overhead. rAF gaps are not presented-frame timings;
155 ms is still a noticeable stall. Summed RSS is comparative only because
shared process mappings are double-counted.

A replacement six-case run explicitly selected and asserted the view, then
passed complete count, visible final-row selection and typed navigation away in
Details, List and Tiles. One baseline/candidate pair per view recorded gaps of
469/175 ms (Details), 453/159 ms (List), 473/167 ms (Tiles). These single pairs
qualify outcomes and direction, not a distribution. The original rejected view
labels remain explicit in the JSON.

The first explicit-view baseline retry timed out after typing the final path and
pressing Enter. A known autocomplete suggestion race is plausible but was not
proved by the available trace. The harness now records focus/value/dropdown state
and dismisses a visible suggestion dropdown with Escape before Enter. None of the
six successful runs had a visible dropdown, so that conditional was not exercised.
No production focus/navigation workaround was added; the original failure log is
retained. Browser contracts also cover all three views.

## Ownership and attribution

The listing alone uses `$state.raw<readonly FileEntry[]>`, exposed through the
existing core-state accessor. Navigation, loading, view preferences and selection
retain their existing reactivity. Publishers replace immutable revisions, and an
unchanged refresh retains its array identity. No deep freeze or redundant clone
is added. This follows [Svelte's large immutable-state guidance](https://svelte.dev/docs/svelte/$state#state.raw).

Temporary instrumentation, identical on the two profiling builds, measured
100k filtering/sorting at roughly 199–215 ms with deep proxies versus 18–19 ms
with raw revisions (three samples each). Status scans also fell. Final startup
and interaction binaries contain none of that instrumentation. An attempted
`JSON.parse` probe recorded no calls; it does not establish IPC decode cost.
The remaining frame gap needs separate attribution before choosing another fix.

## Regression and provenance

The browser regression runs Svelte's actual client compiler and checks revision
and entry identity, rendered publication, item count and selection in every view.
Reverting only the raw accessor makes all three identity cases fail; restoring it
passes. Unit contracts cover replaced metadata, cursor resolution, retained
selection and unchanged-refresh identity.

Validation: 2,501 unit tests passed (3 skipped), 29 performance contracts passed,
80 browser navigation/selection/status/publication tests passed across all views,
Svelte check clean, architecture lint clean, code-map coverage 500/500.

[Machine-readable evidence](arch-listing-737.json) retains executable hashes,
production patch, all startup samples and native interaction results. Baseline
production source is `822f8751`; candidate is `04258e40` plus the embedded production
patch. Those two commits differ only in earlier test/evidence artifacts. Build:
production frontend, `cargo build --release --locked --features tauri/custom-protocol`,
no E2E hooks, default recovery features. Startup never uses a preload shim.
Native WebDriver interaction alone bypasses the release detachment fork with a
shim restricted to the exact tested executable.

An initial interaction matrix attempted to select views through settings only.
Screenshot inspection showed all groups were Details. Its claimed cross-view
coverage was rejected; the replacement harness selects each view through the
command palette and asserts its actual DOM container before and after loading.
