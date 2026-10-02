# #942 — A lost macOS renderer stayed dead, and qualification called it a pass

#936 traced intermittent macOS startup stalls to a WebContent crash (a
JavaScriptCore GC assertion during the first idle full GC after first paint,
in ~1.5% of CI launches). Two defects let it through.

## The app never recovered the window

WKWebView does not reload a page whose WebContent process died; Apple's
guidance for `webViewWebContentProcessDidTerminate` is that the app does.
`renderer_owner::on_web_content_terminated` now retires the generation as
before, then `renderer_owner/reload.rs` reloads the window (at most 3 times in
a sliding 60 s, then `decision=exhausted`), or retires a parked warm window,
which the pool replaces. Every decision is logged as `Renderer(recovery)`.

Traps:

1. **Never read `WKWebView.URL` after a termination.** WebKit resets it and
   Wry's `url_from_webview` unwraps it. The committed URL is recorded from the
   page-load `Started` event (Wry emits it at commit) instead.
2. **Leave the delegate callback before acting.** Navigation and destruction
   run synchronously on the main thread and would re-enter WebKit while it is
   still reporting the termination, so they are spawned.
3. **A plain reload replays one-shot launch requests.** `warm=1` would re-park
   a visible window, `path=` would skip saved tabs, `focusAddressBar=1` would
   steal focus. The recovery URL drops `warm` and adds `rendererRecovery=1`;
   `domain/window-launch-plan.ts` then restores the window's persisted tabs,
   and `launchRequest` returns nothing for a recovered document.

The new document starts a new renderer generation, so the lost page's watches
and sessions stay retired. Terminal PTYs are label scoped and cannot be
reattached, so a reload ends them through `terminal::on_window_destroyed`
(whose label scoping is unit-tested; the WebKit-driven adapter itself is not).

Known gap: if the renderer dies after `warm_pool_activate` commits but before
the page acknowledges activation, the window counts as activated and is
reloaded, but the claimant's acknowledgement timeout later discards it and
opens a fresh window instead. The user still gets one window; the recovered
one is wasted.

Linux logs every webview's loss in the same line format with WebKitGTK's
reason, but does not reload: the `e2e-renderer-recovery` harness reloads its
own WebView after asserting retirement, and an automatic reload would race it.

## Qualification passed samples that lost their renderer

In #936, 2 of 3 crashes landed 6–9 ms after `ui-ready`, inside the survival
interval, and those samples passed. Failing every loss instead would turn a
~1.5% per-launch crash into a red required check on about half of 30-sample
runs, so the qualifier now tests what the product guarantees: recovery.

- The attributed parser rejects any log with a loss, so a loss is never a
  timing sample, and two main-window `Startup(webview)`/`(native-ready)`
  markers are rejected rather than mixing clocks.
- A loss at any point, survival interval included, holds the sample until
  every decision is a recovery and one main document booted after the last
  loss (its `boot-epoch-ms` is later than the loss's `epoch-ms`) reaches
  `native-ready` once. Log order alone is not enough: on the final CI run the
  dying document's in-flight ready IPC was logged 2 ms after the termination
  line, and an order-based check took it for the recovery. That sample is recorded in
  `report.json`'s `rendererLosses` (with its evidence directory), excluded
  from the percentiles, announced as a `::warning`, and replaced by another
  launch.
- It fails on `exhausted`/`reload-failed`, no recovery within one sample
  timeout of the loss (so a lost sample can take about twice the timeout),
  the app exiting first (the loss leads the message), unattributable
  second-boot markers, or more than 3 recovered losses (P ≈ 0.2% at the
  measured rate; ~40% at a 10% crash rate).
- Interactive evidence cannot replace a recorded launch, so a loss there
  fails the report with the loss recorded rather than throwing.

Evidence (`sample-NN-renderer-loss/`, before the app is stopped, ADR 0021)
skips the profiles, waits up to 15 s for the WebContent `.ips`, and records its
pid and WebKit build. A main window that fails to become ready after only a
warm window's loss gets stall evidence (with profiles) instead, since the
problem is then a live, stuck main page. `log show` now covers only the sample's own window and
drops WebKit's `Network`/`ResourceLoading` lines, which were half of #936's log
and pushed the crash past the size cap. `report.json` records `sw_vers` and the
system WebKit `CFBundleVersion`, the build crash reports cite.
