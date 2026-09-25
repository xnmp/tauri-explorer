# Arch compact-listing qualification — 2026-09-23

Versioned column transport reduces large-listing delivery cost while keeping the
existing immutable domain snapshot and native watch ownership. This builds on
PR #747, whose binary is the baseline below.

## Fresh-process startup

Twenty measured launches per cell, two excluded warmups, alternating AB/BA.
Nearest-rank percentiles, launch timestamp to native readiness receipt:

| Files | Immutable baseline p50 / p95 | Compact transport p50 / p95 |
| ---: | ---: | ---: |
| 100 | 370.4 / 380.6 ms | 371.1 / 384.3 ms |
| 100,000 | 653.1 / 705.8 ms | 594.5 / 616.5 ms |

Large-directory nearest-rank p50 improves by 9.0%; small-directory startup is
essentially unchanged. This is Arch/Ryzen 9 5900X, a production release with default
features and no E2E hooks, warm uncontrolled OS caches, isolated Xvfb/Openbox X11.
The display reports software-rendering warnings. Session builds and tests were
stopped; unrelated desktop/background work was not controlled. The endpoint is
native receipt after settings, command registration, the initial complete listing
and two frame opportunities. It is not observed presentation or first-input
latency, normal Wayland launch, cold-disk startup, or Mac half-bounce acceptance.
Do not combine percentages across earlier runs with different background load.

## Native interaction and observation

One baseline/candidate pair per explicitly selected and asserted view, 100k files:

| View | Complete count, baseline → compact | Maximum rAF gap, baseline → compact |
| --- | ---: | ---: |
| Details | 355 → 247 ms | 163 → 94 ms |
| List | 351 → 250 ms | 174 → 97 ms |
| Tiles | 350 → 266 ms | 155 → 113 ms |

All six sessions passed exact count, Ctrl+End with the selected final row visible,
real address typing/navigation away during an outstanding load, and external file
creation/removal appearing through the real filesystem watcher. Screenshots are in
`screenshots/fix/listing-delivery-frame-gap/`. One pair per view establishes these
outcomes and direction, not a latency distribution. Keyboard round trips were
104→126, 103→78 and 124→72 ms; they include driver overhead and do not establish
consistent keystroke-latency improvement. Input requests preceded the complete
frame, but this does not prove input preempted synchronous work.

Summed peak process RSS was lower in all three pairs (about 1.01–1.02 GB versus
1.08–1.11 GB). This is comparative only: shared mappings are double-counted and
25 ms sampling can miss transients. A roughly 100 ms frame gap remains; this is
not smooth 60 Hz or Ghostty-level performance qualification.

The first final-baseline watcher check failed because WebDriver `getText` returned
only the icon label despite the correct count. The native suite already documents
CSS-clipped text reads. The corrected harness reads the rendered name from the DOM,
retains displayed-row and removal assertions, and captures the visible filename.
The rejected log is retained in the JSON. No application workaround was added.

## Attribution and design

Temporary baseline probes measured a 20,200,168-character ASCII response in three
runs. `Response.text()` body acquisition/materialization took 76/76/78 ms;
explicit JSON parsing took 35/34/36 ms. The original `Response.json()` wrapper
measured 110/109/116 ms. Filtering/sorting was about 18 ms. These are broad
application-world timings, including scheduling and possible GC, not a native
WebKit CPU profile or precise GC attribution. WebKit exposed no long-task or GC
observer. The split probe changes the decode mechanism and is diagnostic only.
Final measurement binaries contain none of those probes.

Rust serializes borrowed columns from its existing shared entries; optional
all-false/all-null metadata columns are omitted. A prefix is shared only when it
reconstructs every original path exactly, otherwise full paths are sent. The API
adapter validates the version and aligned columns, then creates ordinary immutable
entries. Stores, providers, snapshots, latest-request publication and views keep
their current model. Raw acquired leases are captured before decoding so a decode
failure can release observation through the existing owner.

## Verification and provenance

Shared authored Rust/TypeScript fixtures cover Windows extended paths, aliases,
Unicode, fallback paths, empty/relative listings and mixed optional metadata.
Contracts reject malformed compact snapshots and retain acquired-lease cleanup;
the actual private observed-listing struct is serialized in its own test module.
Trusted legacy browser fixtures retain their domain shape without row validation;
providers bypass the native adapter.

Validation: 2,506 unit tests passed (three skipped), 29 performance contracts,
1,270 active Rust library tests (21 ignored), strict all-target Clippy, clean Svelte
check and architecture lint, code maps 502/502. Three Rust socket/cache tests failed
under the sandbox and passed with the required permissions. Eighteen native
outcomes passed across six sessions. Independent source and evidence review is
recorded with the machine-readable results.

[Machine-readable evidence](arch-listing-748.json) contains all 88 startup samples,
raw native outcomes, diagnostic observations, executable/source hashes, production
patch and runner sources. Baseline binary provenance is in
[the preceding qualification](arch-listing-737.json). Native WebDriver alone uses
an exact-executable fork bypass; startup never does. No Windows/macOS performance
or runtime qualification follows from these Arch results.
