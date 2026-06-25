# Performance Review — Perceived UX Latency

_Last reviewed: 2026-06-25. Scope: cold start, directory navigation, and per-frame
input/scroll response. Companion to [perf-window-load.md](perf-window-load.md)
(cold-start deep-dive)._

## TL;DR

Search is **not** the bottleneck — `nucleo` already matches 170k paths in single-digit
milliseconds, which is below the perception threshold. The latency users actually feel
lives in two places:

1. **Directory navigation into large folders** — two confirmed `O(n²)` patterns on the
   ingest path.
2. **Per-frame input response** (selection, scroll, marquee) — un-throttled and
   un-memoized per-row work that makes a single click re-do work across every visible row.

A trigram search index would optimize the one path that is already fast. Skip it.

### Perception thresholds we are designing against

| Budget | Feel |
|--------|------|
| < 16 ms (1 frame) | instant |
| < 100 ms | responsive |
| 100 ms – 1 s | noticeable, breaks flow |
| > 1 s | feels broken |

A 15 ms → 3 ms "5×" win on search is invisible: both are under one frame.

### Method & confidence

Findings are static analysis + cost reasoning, **not** profiler flame-graphs — the dev
server runs on mock IPC (`mock-invoke.ts`), so it cannot time real filesystem/IPC cost.
Bundle sizes (below) are measured from a real `bun run build`. The two `O(n²)` findings
and the streaming architecture were verified by reading the source directly. Treat all
"~Xms" as engineering estimates until [instrumentation](#0-add-real-timing-first) lands.

---

## What's already good — do NOT "fix" these

- Details-view virtual scrolling (`VirtualList.svelte`, fixed-height O(1) layout math).
- Two-tier progressive thumbnails (16px micro placeholder → full).
- 5 s directory listing cache (`dir_listing.rs`).
- **PreviewPane / highlight.js already code-split** — `+page.svelte:383` uses
  `{#await import(...)}`. The `perf-window-load.md` claim that it's in the main chunk is
  **stale**; it was already fixed.
- Selection is an O(1) `Set<string>`; Tauri event listeners are torn down correctly (no leak).
- NerdFont (2.44 MB) is `font-display: swap` and only fetched when a `.nf-icon` actually
  renders — default-icon-theme users never pay for it.

### Measured bundle (prod build)

| Chunk | Raw | Gzip | Notes |
|-------|-----|------|-------|
| main client chunk | 516 KB | 157 KB | Svelte + app code + statically-imported dialogs |
| hljs chunk | 197 KB | 64 KB | **lazy** — loads only with PreviewPane (29 languages) |
| `_page` CSS | 142 KB | — | all themes shipped together |
| NerdFont .ttf | 2.44 MB | — | `swap`, lazy per `.nf-icon` |

The 516 KB main chunk is the realistic cold-start lever (everything in `+page.svelte`'s
static import list loads up front), but it's secondary to the navigation/render fixes below.

---

## Ranked findings

| # | Finding | Where | Impact | Effort |
|---|---------|-------|--------|--------|
| **1** | `O(n²)` entry accumulation — `entries = [...entries, ...batch]` per stream batch | `explorer.svelte.ts:154` | Jank filling large dirs (~1.27M copies @5k) | **S** |
| **2** | Full filter+sort re-runs on **every** batch (`displayEntries` fires 50× for a 5k dir) | `explorer.svelte.ts:99-116` | `O(n²·log n)` main-thread churn | **S** |
| **3** | All visible rows re-render on any single selection change | `DetailsView.svelte:159`, `ItemButton.svelte:49` | Click/marquee feels heavy | **M** |
| **4** | Per-row formatting not memoized (`formatDate`/`toLocaleString`/`getFileType`/`formatSize` every render) | `FileItem.svelte:123-140` | Compounds #3 | **S** |
| **5** | `isInClipboard` does an `O(n)` array scan ×2 per row per render | `use-item-interactions.svelte.ts:114` | 15k compares/render w/ 50-item clipboard | **S** |
| **6** | Full backend scan (incl. `is_empty` `read_dir` per subdir) before first paint | `dir_listing.rs:233`, `mod.rs:122-126` | Every nav waits on all stat work | **M** |
| **7** | Scroll handler not rAF-batched (`$state` write per scroll tick) | `VirtualList.svelte:45-47` | Scroll jank on fast wheel / 144 Hz | **S** |
| **8** | Tiles view not virtualized + unbounded thumbnail queue (no scroll cancellation) | `TilesView`, `ThumbnailImage.svelte:117` | 500-image folder = 500 mounted comps + queued invokes | **M** |
| **9** | Theme flash — applied only after `listUserThemes` IPC resolves | `theme.svelte.ts`, `+page.svelte:252` | Wrong-theme flash every launch | **S** |
| **10** | Two-hop sequential IPC on first listing (`await listen` → `await startStreamingDirectory`) | `directory-listing.ts:100-109` | +1 round-trip before entries | **S** |
| **11** | Animated backgrounds run `O(N²)` rAF loop unconditionally | `particles.ts:60`, `starfield.ts:54` | Steals frames during scroll (if enabled) | **S** |
| **12** | Double sort (Rust by-name then JS re-sort) + `{...coreState}` spread per change | `dir_listing.rs:208`, `explorer.svelte.ts:93` | Redundant work, minor | **S** |
| — | git `status --porcelain -uall` on nav can be seconds in a monorepo | `git_status.rs:143` | Severe **but off by default** | **M** |

---

## The two clusters that matter

### Cluster A — large-directory navigation (#1 + #2)

Same root cause, one fix. Streaming a 5000-entry dir arrives in 50 batches of 100. Today
each batch does:

```ts
// explorer.svelte.ts:154 — inside dirListing.load onEntries callback
coreState.entries = [...coreState.entries, ...entries];
```

- **#1:** spreading the growing array each batch = 100 + 200 + … + 5000 ≈ **1.27M element
  copies** for one directory.
- **#2:** that write invalidates `displayEntries` (`explorer.svelte.ts:99-116`), which
  re-runs `filterHidden` + `sortEntries` over the **whole accumulated array** — 50 times,
  on growing arrays → `O(n²·log n)` total, all on the main thread.

**Fix (matches the functional style):** accumulate batches into a non-reactive local
buffer, assign `coreState.entries = buffer` **once** on `onDone` (or throttle to ~one
assignment per 250 ms for very large dirs). The first-100 inline paint already gives
instant perceived response; this just stops the main thread thrashing during fill-in.
`O(n²·log n)` → `O(n·log n)`, 50 reactive flushes → 1–2.

### Cluster B — input responsiveness (#3 + #4 + #5)

Every visible row reactively reads the `selectedPaths` Set and **also** recomputes
`new Date().toLocaleString()` + clipboard array-scans on each render. So one click re-does
all of that across ~34 rows (Details) or ~150 items (List/Tiles). Fixes:

- **#4:** make per-row `formatDate` / `getFileType` / `formatSize` `$derived` (per the repo
  rule: prefer `$derived` over recomputing in template expressions).
- **#5:** make the clipboard a `Set` lookup instead of `entries.some(...)`.
- **#3:** decouple row selection so only the two affected rows re-render, not all visible.

---

## Cold start (#9 + #10)

`perf-window-load.md` is mostly right but partly stale (verified against current code):

- ✅ `init_watcher` still runs synchronously before `builder.build()` (its P2 is valid).
- ✅ settings.json read is synchronous in `setup()` — **but only on macOS/Windows** (cfg-gated; doc omits this).
- ❌ PreviewPane/highlight.js already lazy (its P0 / "bottleneck #1" is done — don't redo).
- ⚠️ Theme is **not** injected from Rust yet — `init_script` injects only `cwd`/`home`. The flash (#9) is real.
- `listen()` + `startStreamingDirectory` are genuinely sequential (#10) — a mandatory two round-trips before first entries.

Highest-value cold-start moves: inject `data-theme` into the Rust `init_script` (kills the
flash), and apply theme from synchronous localStorage before the `listUserThemes` IPC.

---

## How to verify — perf testing in this repo

There is already a real harness. Use it; don't invent a new one.

### The three layers that exist

| Layer | Command | What it covers | File |
|-------|---------|----------------|------|
| **Micro-benchmarks** (Vitest) | `bun run test:perf` | Pure-function cost: `sortEntries`, `filterHidden`, `formatSize`, virtual-range math, selection ops. Each `it()` asserts a hard ms budget via `assertPerformance`. | `tests/perf/*.bench.ts` |
| **Regression gate** | `bun run perf:check` / `perf:baseline` | Runs the benchmarks, diffs avg-ms against `perf-baseline.json`, **fails CI on >50% regression**. | `scripts/perf-check.ts` |
| **E2E wall-clock** (Playwright) | `bun run test:e2e -- e2e/performance.spec.ts` | Real user scenarios against the mock-IPC dev server: cold start <3s, folder nav <500ms, scroll frame-time, selection <300ms, quick-open, tabs. | `e2e/performance.spec.ts` |

Workflow: `bun run perf:baseline` to snapshot current numbers → make the change →
`bun run perf:check` to confirm no regression (and ideally an improvement). CI runs this
via `.github/workflows/perf.yml` in a contention-free job.

### ⚠️ The harness has a blind spot for our #1 finding

The existing benchmarks call the pipeline **once on the full array**
(`directory-scan.bench.ts` sorts/filters 10k entries a single time). But finding **#1/#2
is about re-running the pipeline 50× across _growing_ arrays as batches stream in.** A
single-shot benchmark cannot catch a per-batch `O(n²)` regression — it would pass today
and pass after the fix, showing nothing.

**To verify Cluster A, add a batch-accumulation benchmark** that reproduces the real
ingest loop. New file `tests/perf/streaming-ingest.bench.ts`:

```ts
import { describe, it } from "vitest";
import { testData } from "./mock-data";
import { benchmark, formatResult, assertPerformance } from "./perf-utils";
import { sortEntries, filterHidden } from "$lib/domain/file";
import type { FileEntry } from "$lib/domain/file";

/** Reproduce the current navigateInternal onEntries loop: 50 batches of 100,
 *  full filter+sort recomputed on each batch (what displayEntries does today). */
function ingestBatchedCurrent(all: FileEntry[], batch = 100): FileEntry[] {
  let entries: FileEntry[] = [];
  let display: FileEntry[] = [];
  for (let i = 0; i < all.length; i += batch) {
    entries = [...entries, ...all.slice(i, i + batch)]; // #1: O(n) copy per batch
    display = sortEntries(filterHidden(entries, false), "name", true); // #2: full re-sort per batch
  }
  return display;
}

/** Target after fix: accumulate, sort+filter once at done. */
function ingestBufferedOnce(all: FileEntry[], batch = 100): FileEntry[] {
  const buffer: FileEntry[] = [];
  for (let i = 0; i < all.length; i += batch) buffer.push(...all.slice(i, i + batch));
  return sortEntries(filterHidden(buffer, false), "name", true);
}

describe("Streaming ingest (5000-entry directory)", () => {
  it("buffered-once stays under 15ms", () => {
    const r = benchmark("ingest-buffered-5000", () => ingestBufferedOnce(testData.large), 50);
    console.log(formatResult(r));
    assertPerformance(r, 15);
  });

  // Keep the "current" variant as a documented baseline of the bug; remove or
  // flip its budget once the fix lands so it guards against reintroduction.
  it("documents the O(n^2) cost of per-batch re-sort", () => {
    const r = benchmark("ingest-current-5000", () => ingestBatchedCurrent(testData.large), 20);
    console.log(formatResult(r)); // expect this to be many× slower than buffered-once
  });
});
```

The gap between the two numbers _is_ the win. After implementing the buffer fix in
`explorer.svelte.ts`, the production path matches `ingestBufferedOnce`.

### Verifying each finding

| Finding | How to verify |
|---------|---------------|
| **#1/#2** ingest `O(n²)` | New `streaming-ingest.bench.ts` above; assert `buffered-once` < 15 ms. E2E `folder-navigation` budget (currently 500 ms) tightened once on real data. |
| **#3** selection re-render | Playwright `single-selection` test exists (`performance.spec.ts:271`) but its 300 ms budget is loose. Add a count-based assertion: instrument a dev-only render counter and assert only the changed rows re-render (or measure frame time during `Ctrl+A` on a large mock dir). |
| **#4/#5** per-row work | Micro-bench `formatDate`/`getFileType` over 10k like the existing `formatSize-10000` test; assert memoized path is ~0 on re-render. |
| **#6** backend scan | Needs Rust-side timing (see below) — micro-benches are JS-only. Add a `criterion` bench or `tracing` span around `scan_directory_parallel` and compare with/without deferred `is_empty`. |
| **#7** scroll | `performance.spec.ts` already has `scroll response under 16ms` and `rapid scroll does not freeze`. Tighten the avg-frame budget from 100 ms toward 16 ms after rAF batching. |
| **#9** theme flash | Visual — Playwright screenshot on first paint asserting `data-theme` is set before `.explorer` is visible. |
| **#11** animated bg | Micro-bench the per-frame `draw()` cost; assert idle-pause when not focused / interacting. |

### What's missing and worth adding

1. **`tests/perf/streaming-ingest.bench.ts`** — closes the batch-accumulation blind spot (above). _Do this first; it's the gate for the highest-value fix._
2. **Rust-side benchmarks** — there are currently **none** (no `criterion`, no
   `[[bench]]`, no `benches/`). #6 (per-entry syscalls, `is_empty`) and #12 (double sort)
   are backend costs invisible to the JS harness. Add `criterion` benches around
   `scan_directory_parallel` and `metadata_to_entry`, or a `tracing`-span timing harness
   behind a cargo feature.
3. **Real-binary timing (#0)** — the dev server's mock IPC means none of the above measures
   true filesystem/IPC latency. See next section.

### 0. Add real timing first

Before/after numbers on the paths that actually matter (nav IPC, first paint, cold start)
require timing the **real Tauri binary**, not the mock dev server. Two low-cost options:

- **Frontend marks:** wrap the nav path with the existing `performance.mark`/`measure`
  helpers (`perf-utils.ts`) — emit `nav-start` in `navigateInternal` and `nav-first-paint`
  when `displayEntries` first renders; read them from the webview devtools or log them.
- **Rust spans:** add `tracing` spans (or plain `Instant::now()` deltas behind a
  `perf-logging` cargo feature, mirroring the existing `search-progress-logging` pattern in
  the conaticus-style codebases) around `scan_directory_parallel`, the `is_empty` loop, and
  serialization. Log on a real large directory (e.g. a `node_modules`).

Then measure on a known fixture (small ~20-file dir, large ~5000-file dir, a git monorepo)
**before** touching code, so each fix has a real delta — not just a green micro-bench.

---

## Recommended sequence

1. **#0** — add streaming-ingest bench + real timing (so fixes are measurable).
2. **#1 + #2** — buffer batches, single assignment. _Biggest nav win, smallest diff._
3. **#4 + #5** — memoize row formatting, `Set`-ify clipboard check.
4. **#3** — decouple selection re-render.
5. **#7** — rAF-batch the scroll handler.
6. **#9** — kill theme flash via Rust `init_script`.
7. **#6 / #8** — defer `is_empty` off the critical path; virtualize Tiles _(larger; ship after the above)_.

All of this is in the navigation/render path — the work that compounds into "feels
instant." None of it is search.

---

## Progress log

- **#1/#2 shipped** (`feat/streaming-ingest-batching`): buffered streamed batches off the
  reactive graph. 5000-entry ingest ~68ms → ~2.8ms.
- **#9 shipped**: theme applied from Rust `init_script` (pre-bundle) + JS module load. No flash.
- **#10 shipped**: `directory-entries` listener registered once and reused across loads;
  removes a per-navigation IPC round-trip.

---

## Cold-start deep-dive

For small-directory workloads the directory-work fixes barely register — cold start
dominates the felt experience. Findings in critical-path order.

### Critical path (verified against current code)

```
Rust setup()              webview create        bundle parse           mount + first paint
  init_watcher (sync)   →  build() (platform) →  516KB JS / 142KB CSS →  navigateTo (IPC)
  + macOS/Win settings read                      parse + execute
```

The Rust side is already instrumented (`t_start`/`t_plugins`/`t_setup` in `lib.rs`, logged
as `Startup: ...`). Read that on a real build before optimizing the backend half — it's the
one hard number we have there.

### The remaining lever: the 516 KB / 157 KB-gzip main chunk

`PreviewPane`/highlight.js (197 KB) and `marked` are *already* code-split. But twelve
overlay dialogs — none visible at startup — are statically imported into the cold-start
chunk via `open={...}` props. They can be `{#if open}{#await import(...)}`-loaded.

Measured unique payload (raw / gzip), ranked by value × safety:

| Rank | Component | Unique raw | ~gzip saved | Safe to lazy-load? |
|------|-----------|-----------|-------------|--------------------|
| 1 | SettingsDialog (+ KeybindingsSettings) | ~56 KB | ~15–18 KB | Yes — effects all `open`-gated |
| 2 | ContentSearchDialog (+ unique composable) | ~36 KB | ~10–12 KB | Yes — no hljs, no idle listeners |
| 3 | QuickOpen (+ fuzzy-score) | ~36 KB | ~10–11 KB | Yes — singleton import (one-shot IPC defers cleanly) |
| 4 | CommandPalette | ~16 KB | ~5 KB | Yes — zero unique deps, cleanest |
| 5 | FilePicker | ~12 KB | ~3–4 KB | Yes — already dead code in normal windows |

Ranks 6–11 (BulkRename, NanoBanana, Workspace, ThemePicker, OptionPicker, JobsPanel,
ConflictDialog) each save only ~2–3 KB gzip (deps all shared) — a second-pass cleanup.

**Top-5 combined: ~43–50 KB off a 157 KB gzip chunk — a ~27–32% reduction** in cold-start
JS to parse+execute. Each is a small `{#if}`-gated dynamic import; risk is per-component
(verify the overlay still opens), so land them as one branch with an e2e per dialog.

### What is NOT worth touching

- **Inter font** — `font-display: swap`, served from local `asset://` in Tauri (≈zero
  latency). No paint block.
- **NerdFont** — already lazy per `.nf-icon`.
- **CSS (142 KB, all themes)** — parse is cheap; theme switching needs them present. Low value.
- **Webview `build()`** — platform-fixed. Don't put sync work before it (`init_watcher` is
  the only candidate — P2 in perf-window-load.md, ~10 ms, optional).

### Recommended cold-start sequence

1. ~~Read the real `Startup:` log + add a frontend mount→first-paint mark.~~ **Done** — see
   "Measuring cold start" below.
2. ~~Lazy-import the **top-5 dialogs**.~~ **Done** — main client chunk 516→450 KB raw,
   ~157→138 KB gzip (−19 KB, ~12%).
3. Optional: background `init_watcher`; per-theme CSS split (low value).

### Measuring cold start

Two log lines, written to the app log file (`~/Library/Logs/com.explorer.app/tauri-explorer.log`
on macOS; platform log dir elsewhere — see `get_log_dir`). Durable in release builds, no
devtools needed.

- **`Startup:`** (Rust, `lib.rs`) — `pre-builder` (sync work before window create) +
  `builder→setup` (webview creation, **platform-fixed**) + `total`. Historically
  `builder→setup` is ~110–225 ms; `pre-builder` is microseconds.
- **`Startup(webview):`** (frontend, `startup-timing.ts`) — milestones from boot `t0`
  (anchored in `app.html`'s head script, before the bundle loads):
  - `bundle-exec` — bundle parsed + executing (the JS download+parse cost the
    dialog lazy-loading targets)
  - `mount` — `onMount` fired
  - `list-visible` — first directory listing rendered (`total`)

Read them together: the Rust line is the backend half (≈fixed), the webview line is the
half we can move. To get a before/after on the dialog split, compare `bundle-exec` across
a revert. Note the timer anchors differ (Rust `Instant` at process start vs webview
`t0` at first script run), so don't add the two totals — read each half on its own axis.
