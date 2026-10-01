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
and sessions stay retired. Terminal PTYs are label scoped and are not
reattached.

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
  every decision is a recovery and the main window reaches `native-ready`
  exactly once after its last loss. That sample is recorded in
  `report.json`'s `rendererLosses` (with its evidence directory), excluded
  from the percentiles, announced as a `::warning`, and replaced by another
  launch.
- It fails on `exhausted`/`reload-failed`, no recovery within the sample
  timeout, unattributable second-boot markers, or more than 3 recovered losses
  (P ≈ 0.2% at the measured rate; ~40% at a 10% crash rate).
- Interactive evidence cannot replace a recorded launch, so a loss there
  fails the report with the loss recorded rather than throwing.

Evidence (`sample-NN-renderer-loss/`, before the app is stopped, ADR 0021)
skips the profiles, waits up to 15 s for the WebContent `.ips`, and records its
pid and WebKit build. `log show` now covers only the sample's own window and
drops WebKit's `Network`/`ResourceLoading` lines, which were half of #936's log
and pushed the crash past the size cap. `report.json` records `sw_vers` and the
system WebKit `CFBundleVersion`, the build crash reports cite.
