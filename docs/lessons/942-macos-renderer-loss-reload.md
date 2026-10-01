# #942 — A lost macOS renderer stayed dead, and qualification called it a pass

#936 traced the intermittent macOS startup stalls to a WebContent crash: a
JavaScriptCore GC assertion (`MarkedBlock::dumpInfoAndCrashForInvalidHandleV2`
while marking a `JSString`), during the first idle full GC after first paint,
in about 5% of CI launches. Two separate defects let it through.

## The app never recovered the window

WKWebView does not reload a page whose WebContent process died. Apple's
guidance for `webViewWebContentProcessDidTerminate` is that the app reloads it,
and Wry only forwards the callback. Our handler logged the loss and retired
the renderer generation, so the window stayed blank for good.

`renderer_owner::on_web_content_terminated` now retires the generation as
before, then `renderer_owner/reload.rs` decides what to do:

- A window gets at most 3 reloads in a sliding 60 s. A page that crashes on
  every boot stops after three short attempts and logs `decision=exhausted`
  instead of flashing forever. The budget lives in the window's resource
  table, so a reused label starts fresh.
- A parked warm window (ready, booting, or claimed without acknowledged
  activation) is retired instead: it is not user-facing, the pool replaces it,
  and a pending claim already falls back to a fresh window when its
  acknowledgement fails.
- Every decision is logged as `Renderer(recovery): window=… decision=…`.

Three implementation traps:

1. **Do not read `WKWebView.URL` after a termination.** WebKit resets the
   page-load state when the process exits, and Wry's `url_from_webview`
   unwraps the URL. The adapter records the committed URL from Tauri's
   page-load `Started` event instead (Wry emits it at commit), and falls back
   to `reload()` only if nothing was ever committed.
2. **Leave the delegate callback before acting.** Navigation and window
   destruction are dispatched through the event loop; called from the main
   thread they run synchronously, re-entering WebKit while it is still
   reporting the termination. The adapter spawns them onto the async runtime.
3. **A plain reload replays the launch URL.** That URL carries one-shot
   requests: `warm=1` would re-park a visible, activated warm window that no
   claim will ever activate; `path=` makes a child skip its saved tabs; the
   main window would jump back to its CLI cwd; `focusAddressBar=1` would steal
   focus again. The recovery document is the last committed URL plus
   `rendererRecovery=1`. `domain/window-launch-plan.ts` then restores the
   window's own persisted tabs (the label-keyed `explorer-tabs` entry, written
   within 150 ms of any change and kept by WebKit outside the WebContent
   process), and every one-shot request is read through `launchRequest`,
   which returns nothing for a recovered document.

The reloaded document starts a new renderer generation, so watches, Git
leases and file-history channels from the lost page stay retired and stale
session IDs are still rejected. Terminal PTYs are window-label scoped, not
generation scoped: they keep running until the window closes and the
recovered page does not reattach them.

Linux and Windows keep their existing behaviour (retire only). The Linux
`e2e-renderer-recovery` harness reloads the retained WebView itself after
each crash; an automatic product reload there would race it.

## Qualification passed samples that lost their renderer

The startup qualifier only noticed renderer loss when it prevented readiness.
In #936's run, 2 of the 3 crashes landed 6–9 ms after `ui-ready`, inside the
survival interval, and those samples passed. With the reload, even the third
would have "recovered" and passed.

Now the attributed parser (the one readiness predicate and report source,
#696) rejects any log containing `Renderer(web-content-terminated)`, and the
wait checks for it on every poll, through the survival interval and once more
when it ends. The failure leads with `renderer lost: window=… WebContent
terminated at app-run …ms (decision=…)` and the last progress mark of the lost
document only: `logBeforeRendererLoss` cuts the log at the loss so the
reloaded document's marks are not attributed to it. Two `Startup(webview)` or
`Startup(native-ready)` lines for `main` are also rejected outright, since
taking the first match would mix two documents' clocks.

## Evidence

A renderer-loss sample captures `sample-NN-renderer-loss/` before the app is
stopped (ADR 0021). It skips the 3 s profiles, which can only show survivors,
and waits up to 15 s for the WebContent `.ips`, which ReportCrash writes after
the process has gone. `evidence.json` lists the terminated WebContent pids,
from the crash report (`pid`, `build_version`, `captureTime`) and from
unified-log lines that pair `PID=` with `webPageID=`.

Stall capture also changed: `log show` now keeps the newest 4 MiB rather than
the oldest, and excludes WebKit's `Network`/`ResourceLoading` categories, which
were half of all lines in #936 and pushed the crash past the old head cap. The
log runs before the profiles, so pages it names are profiled first.

`report.json` records `sw_vers` (`osProductVersion`, `osBuildVersion`) and the
system `WebKit.framework` `CFBundleVersion`, the build the crash reports cite.
`release` alone is the Darwin version and cannot be matched to a crash report.
