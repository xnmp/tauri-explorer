# #931 — A parked warm window must not run foreground feeds, and tests must not script it

After #921 (one UDisks2 subscription, pushed `drives-changed`), Ubuntu native
smoke lost its WebDriver session in `window-transfer-lifetime.spec.ts` in about
5 of 11 suite runs containing #921. Before that it happened once in about 190
jobs. The command stalled for 12–23 s, returned `Could not parse script result`,
and was followed by `session deleted because of page crash or hang`.

## What the logs established

- The stalled page was always the **parked warm window** (`explorer-warm-*`,
  launched hidden with `?warm=1`). Its handle had only ever reported a `null`
  `e2eWindowLabel`, the page had booted a few seconds earlier, and in
  successful runs the same page answers a script in about 2 ms. The page
  wedges; this is not a harness-only timeout.
- The script that stalled came from harness loops that script **every**
  handle: `selectWindowByLabel` (via `switchToLabel`) and the success-path
  `captureDiagnostics("qualification-complete")`. The one pre-#921 occurrence
  (run 36433792218) had the same signature.
- GitHub's Ubuntu runners run `udisks2.service`, so under #921 the drive feed is
  live there. Every page, the hidden warm one included, subscribed to
  `drives-changed` and `directory-changed`, queried `drive_updates_live`, read
  `list_drives` twice during boot, and kept a poll timer.
- No WebKitWebProcess stderr or crash signal was retained, and 33 local runs
  (GPU and `LIBGL_ALWAYS_SOFTWARE=1`) did not reproduce it, so the exact WebKit
  failure inside the hidden page is still unobserved. The rate change was
  measured by CI A/B instead (PR for #931).

## Rules

1. **Foreground-only feeds start through `state/page-foreground.ts`.** A parked
   (or measuring) warm window starts with the gate closed. `whenForeground`
   defers a feed's start and `enterForeground` runs every deferred start and
   resolves when they have settled. `drivesStore` starts its read, watches,
   subscriptions and poll only through the gate, so a parked page makes no
   drive IPC and registers no drive listeners.
2. **Activation opens the gate before reveal.** `runWarmWindow`'s `navigate`
   step awaits the gate alongside the requested listing, and `show` follows
   it, so a claimed window never shows the parked page's empty or stale drives.
   Mounts that happened while parked are read on activation.
3. **Tauri 2 only evaluates an emit in webviews that have a JS listener** for
   that event (`emit_js_filter`). Not subscribing while parked is therefore
   enough to keep backend `drives-changed` pushes out of parked pages; no
   Rust-side filter is needed.
4. **Never script a page the test does not own** (#885). A warm window keeps its
   `?warm=1` launch URL, and only a warm window carries an `explorer-warm-`
   label. Label scans (`selectWindowByLabel`, `switchToFreshWindow`) read each
   handle's URL through the driver and skip warm pages unless the requested
   label is a warm label. `captureDiagnostics` records warm pages by URL
   without scripting them, and success paths do not capture every window.
