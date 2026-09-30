# #931 — Tests must not script parked warm windows, and parked pages run no feeds

After #921 (one UDisks2 subscription, pushed `drives-changed`), Ubuntu native
smoke lost its WebDriver session in `window-transfer-lifetime.spec.ts` in about
5 of 11 suite runs containing #921. Before that it happened once in about 190
jobs. The command stalled for 12–23 s, returned `Could not parse script result`,
and was followed by `session deleted because of page crash or hang`.

## What the logs established

- The stalled page was always the **parked warm window** (`explorer-warm-*`,
  launched hidden with `?warm=1`). Its handle had only ever reported a `null`
  `e2eWindowLabel`, it had booted a few seconds earlier, and in successful runs
  the same kind of page answers a script in about 2 ms.
- The script that stalled came from harness loops that script **every**
  handle: `selectWindowByLabel` (via `switchToLabel`) and the success-path
  `captureDiagnostics("qualification-complete")`. The one pre-#921 occurrence
  (run 36433792218) had the same signature.
- **The drive feed is not the cause.** With every drive listener and poll
  deferred until activation, a parked page still stopped answering script:
  in run 36780672273 a parked page that had logged `warm parked` (so it had
  finished booting and registered) hung a `findElement` for 28 s. What makes a
  hidden, never-shown page stop answering WebDriver is not established, nor
  what raised the rate after #921.
- `warm-window.spec.ts` produced that case itself: the warm label is readable
  before the page registers with the pool, so Ctrl+N in that gap correctly
  opened a fresh window, and the spec then scripted the still-parked page as if
  it had been activated. Wait for `e2eWarmReady` before claiming.
- No WebKitWebProcess stderr or crash signal was retained, and 33 local runs
  (GPU and `LIBGL_ALWAYS_SOFTWARE=1`) did not reproduce it.

## Rules

1. **Never script a page the test does not own** (#885). A warm window keeps its
   `?warm=1` launch URL, and only a warm window carries an `explorer-warm-`
   label. Label scans (`selectWindowByLabel`, `switchToFreshWindow`) read each
   handle's URL through the driver — WebDriver answers `getUrl` without running
   page script — and skip warm pages unless the requested label is a warm
   label. `captureDiagnostics` records warm pages by URL without scripting them,
   and success paths do not capture every window. This is what stops the
   session loss.
2. **A parked page runs no ongoing feeds.** Foreground-only feeds start through
   `state/page-foreground.ts`: a parked (or measuring) warm window starts with
   the gate closed, and `enterForeground` runs the deferred starts. The drive
   store reads the list once while parked, so a claimed window is revealed with
   its drives, but it registers no `drives-changed`/`directory-changed`
   listeners and keeps no poll timer until activation, which re-reads.
3. **Never await a feed before reveal.** Activation starts the deferred feeds
   and does not wait for them. Windows enumerates drives through PowerShell
   (`windows_volume_info`), which took longer than the 10 s activation
   acknowledgement on a CI runner: the Windows bounded soak failed with
   `Ctrl+N did not reveal the ready warm window` while `show` waited on it.
4. **Tauri 2 only evaluates an emit in webviews that have a JS listener** for
   that event (`emit_js_filter`). Not subscribing while parked is enough to
   keep backend `drives-changed` pushes out of parked pages; no Rust filter is
   needed.
5. To tell whether a parked page finished booting without scripting it, pair
   its `[window tab seed]` app-log line with `[warm parked]`
   (`Retire-when: #931 closed`). A missing `[warm parked]` line is only
   meaningful if the app kept running: a spec that ends within a second of
   priming kills the page before it registers.
