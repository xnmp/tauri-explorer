# #931 — Never script a parked warm window; a parked page runs no foreground work

After #921 (one UDisks2 subscription, pushed `drives-changed`), Ubuntu native
smoke lost its WebDriver session in `window-transfer-lifetime.spec.ts` in about
5 of 11 suite runs containing #921. Before that it happened once in about 190
jobs. The command stalled, returned `Could not parse script result`, and was
followed by `session deleted because of page crash or hang`.

**Root cause: unknown.** What is established is narrower: the session ends
when a test runs script in a page that has stopped answering, and the page
was almost always a parked warm window that the test did not own.

## What the logs established

- The stalled page was a **parked warm window** (`explorer-warm-*`, hidden,
  `?warm=1`). It had booted seconds earlier; the same kind of page answers a
  script in about 2 ms when healthy.
- The stalling script came from harness loops that scripted **every** handle
  (label scans, `captureDiagnostics`, parked-window finders, teardown loops).
- **The drive feed is not the cause.** With every drive listener and poll
  deferred until activation, parked pages still stopped answering: 2 sessions
  lost in 5 product-only runs, and one more on a parked page in run
  36780672273, where `warm-window.spec.ts` still scripted parked pages itself.
- Circumstantial evidence of renderer death, not a slow script (review of
  #934):
  - the stall before `page crash or hang` is uniformly 19–28 s;
  - ordinary main pages that hit the same failure went completely silent
    about 0.7–0.9 s after their `ui-ready` mark, the shape of #936's macOS JSC
    garbage-collection crash;
  - in each warm-page hang, another window had closed about 2 s earlier.
- Nothing records a WebKitGTK renderer's death today. The Linux
  `web-process-terminated` handler (`renderer_owner/termination.rs`) logs
  nothing, and it is installed only on pages that request native ownership.
  Termination logging is #942's work.
- 33 local runs (GPU and `LIBGL_ALWAYS_SOFTWARE=1`) did not reproduce it.

## CI A/B (`smoke (ubuntu-latest)`, full suite)

| Build | Runs | Sessions lost on a warm page | Other sessions lost |
|---|---|---|---|
| baseline with #921 | 11 | ~5 | — |
| product gate only | 5 | 2 | 0 |
| + first harness exclusion (label scans, diagnostics) | 8 | 1 (`warm-window.spec.ts`, not yet guarded) | 2 (`terminal-resize`, `directory-identity`, main pages) |

The renderer losses on ordinary pages still happen, at roughly the pre-#921
background rate.

## Rules

1. **Never script a page the test does not own** (#885). Every native handle
   scan goes through `e2e-tauri/owned-windows.ts`: it reads each handle's URL
   through the driver (no page script) and scripts only a page whose URL is
   known and not `?warm=1`. It fails closed: an empty or unparseable URL is a
   page that has not committed its document, possibly a warm one, so the scan
   retries it later. Teardown loops (`closeOtherWindows`) leave warm windows
   alone.
2. **Find a parked warm window without scripting it.** `parkedWarmWindow`
   asks an owned page for registered hidden warm labels (`warm-ready`: the
   parked page's E2E probe records its registration in shared `localStorage`)
   and takes the handle from the one warm URL the test does not already know.
   A test reaches an activated warm window by that handle, and checks that
   Ctrl+N revealed the claimed window (not a fresh fallback) through
   `target-state` from the main window.
3. **One foreground notion per page.** `state/page-foreground.ts` owns it. A
   parked or measuring page keeps it closed until its activation commits
   (after reveal, commit and acknowledgement), never at navigation: a window
   can still be retired before commit, and it must not claim file-operation
   recovery or start long-lived feeds. Before the gate, a parked page ran its
   own drive feed for its whole life — a PowerShell enumeration every 1.5 s on
   Windows, a 1.5 s poll and `/Volumes` watch on macOS, a 30 s poll plus push
   evaluation on Linux. Starts run synchronously so no stop can slip between
   scheduling a start and running it.
4. **Never await a feed before reveal.** Windows enumerates drives through
   PowerShell, which outlasted the 10 s activation acknowledgement in the
   Windows bounded soak when the reveal awaited it. A claimed window therefore
   shows the drive list it read while parked until its activation re-read
   lands.
5. To tell whether a parked page finished booting without scripting it, pair
   its `[window tab seed]` app-log line with `[warm parked]`
   (`Retire-when: #931 closed`). A missing `[warm parked]` line is meaningful
   only if the app kept running: a spec that ends within a second of priming
   kills the page before it registers.
