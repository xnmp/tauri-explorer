# #593 — Scrolling in a directory full of image thumbnails is laggy

**Symptom:** Tiles view, large-thumbnail size, a directory of 468 3-8MB
wallpapers, cold cache: scrolling stuttered visibly on WebKitGTK
(Arch/Hyprland).

**Root causes (three, stacked):**
1. Thumbnail `<img>` elements had no `decoding="async"` — WebKitGTK decodes
   synchronously at paint time, blocking the frame that reveals each tile.
2. The loading-state placeholder was an animated CSS spinner (border +
   `rotate`) rendered on every tile still loading. WebKitGTK falls back to
   per-frame software rasterization for that animation, and with dozens of
   tiles loading at once during a fast scroll this **doubled the long-frame
   rate**: 16/51 long frames (~33ms/frame) with the spinner vs. 10/120
   (~13ms/frame) with it removed. Same failure family as #104's blur filter —
   *any* continuous CSS animation on a high-cardinality, frequently-mounted
   element is a WebKitGTK compositing tax, not a free effect.
3. Thumbnail decodes ran unbounded on the Tokio blocking pool, competing with
   the webview's own compositor/paint threads for CPU with no backpressure.

**Fixes:**
- `decoding="async"` on both the micro and full `<img>` elements in
  `ThumbnailImage.svelte`.
- Spinner removed entirely — a static SVG placeholder is enough feedback and
  costs nothing per frame.
- A global decode gate in `src-tauri/src/thumbnails.rs`
  (`with_decode_gate`): concurrent decodes clamped to `cores/4` (2-8), decode
  threads get their priority lowered via `setpriority(+10)` for the duration
  (saved/restored, since blocking-pool threads are reused and priority must
  not leak onto unrelated work). Override via `TAURI_EXPLORER_DECODE_PERMITS`
  (`0` disables the gate).

**Negative result — batching hurts pacing even though it helps throughput:**
Micro-thumbnail requests were batched behind a 16ms debounce
(`get_micro_thumbnails_batch`) once before (added in e9491eb3 for a related
issue), silently dropped by an unrelated merge-reconciliation commit
(8e847cd6), and then **reintroduced from scratch during this investigation**
because it looked like an obvious throughput win. Measured, it was worse for
the thing that actually matters here: batched responses arrive as one clump
and resolve ~32 tiles in a single main-thread burst (34/75 long frames,
event-loop stalls >400ms) vs. per-item requests (18/99 long frames). Per-item
requests at decode-pool-size 8 measured at the same long-frame floor as a
build with *no* thumbnails at all (10-12 long/sweep vs. floor 6-9) — i.e.
per-item dispatch is already optimal for scroll pacing, and batching only
optimizes total-load-time, a different metric. It was removed again,
deliberately. **Anyone tempted to re-add batched thumbnail IPC must produce
long-frame/event-loop-stall numbers that beat per-item dispatch, not just a
faster total-load-time.**

**Why this bug kept coming back:** the batching scheduler wasn't reverted by
a deliberate perf decision the first time — it was deleted as a side effect
of resolving merge conflicts (8e847cd6 silently dropped e9491eb3's change
while reconciling an unrelated diff). Nobody re-measured after the drop, so
the regression was invisible until this issue. A perf-motivated change that
can be silently erased by a conflict-resolution merge needs either a
regression test that fails on removal, or — as here — the negative result
written down so a future "let's batch it" doesn't reopen the same debate from
zero.

**Measurement methodology** (needed because the mock-invoke E2E tier is
structurally blind to this class of bug — see CLAUDE.md's Verification
section):
- Frontend: `domain/scroll-jank-monitor.ts`, a pure rAF-gap sampler (rAF/cancel
  injected, unit-testable with synthetic frame timelines). Wired into
  `TilesView.svelte` around scroll activity; reports (`frames`, `longFrames`,
  `worstFrameMs`, `durationMs`) are logged as `tiles-scroll-jank` events via
  `log_frontend_error` **only when jank actually occurred**, so normal
  scrolling doesn't spam the log.
- Backend: `thumb:` timing logs in `thumbnails.rs`'s `diag` module — a line
  per slow request (>100ms) plus an aggregate every 100 requests, broken out
  by cache-hit source (memory/disk/decoded).
- Cold-cache A/B: a scripted scroll driver against a real headless Hyprland
  output (not Playwright/mock-invoke — the whole point is to exercise the
  real Tokio blocking pool, real WebKitGTK paint, and a cold on-disk
  thumbnail cache), comparing long-frame counts and event-loop stall gaps
  between variants (spinner on/off, decode gate on/off, batched/per-item
  IPC).

**Gotchas worth remembering:**
- WebKitGTK's animation-during-load pattern (spinner here, blur filter in
  #104) is now a *repeated* failure family: continuous CSS animation on any
  element that exists in bulk during a busy loading state is disproportionately
  expensive on this engine specifically. Chromium/mock-invoke E2E will not
  reproduce or catch it — it's WebKitGTK-only and timing-dependent.
- A throughput optimization (batch the IPC) and a pacing optimization (keep
  the main thread's per-frame budget small) are different, sometimes opposed,
  goals. Measure long-frame/stall counts, not just total elapsed time, before
  trusting a "fewer round trips is faster" argument for anything that lands
  on the main thread.
