# #457 — Windows smoke hang: what got fixed, what got refuted (issue still open)

## Symptom

From 2026-07-17 the `windows-latest` leg of `Tauri binary E2E (smoke)` consumed
its whole 25-minute `timeout-minutes` cap on every run. Build steps were green;
only "Run smoke suite (Windows)" hung. `ubuntu-latest` ran the same suite in
8–9 minutes. 20+ consecutive runs, no flake — a hard cliff. The leg was later
demoted to manual dispatch, which kept the dashboard green while Windows
coverage silently ceased to exist.

## The reliable signature

Bounding the run (`bail` after the first session failure) turned an opaque
25-minute burn into a readable failure in 61 seconds:

```
[0-0] [Perf] main() pre-run: 316.6µs          <- the app process starts
[0-0] [Perf] dir scan '...': 54 entries ...   <- the frontend runs and lists
[0-0] Error serving connection: hyper::Error(IncompleteMessage)
WebDriverError: The operation was aborted due to timeout when running
"http://127.0.0.1:4444/session" with method "POST"
```

The app is healthy — it boots, the webview executes the frontend, a directory
listing completes. msedgedriver simply never finishes its WebView2 attach, and
`POST /session` times out at exactly WDIO's 60s `connectionRetryTimeout` (the
`IncompleteMessage` is tauri-driver's hyper server reporting the aborted
request, not a cause).

## Hypotheses tested and REFUTED — do not re-litigate these

1. **tauri-driver release regression** — no release since May; killed for free
   by checking crates.io before spending a CI run.
2. **Cold Vite dev-server load** (dev-mode binary dials `devUrl`, msedgedriver
   waits for the page) — plausible, wrong: with the frontend embedded and no
   dev server anywhere, Windows fails identically.
3. **Second WebView2 instance** (warm-window pool parks a hidden window ~1.5s
   after boot; Microsoft documents the "launch" approach as attaching to the
   _first_ instance and multi-instance apps as needing "attach") — suppressing
   priming left one webview (a single `dir scan` in the transcript) and the
   same 60s timeout.
4. **Undrained stdout pipe** (debug builds push a `Stdout` log target; #424
   added ~38 `gitstat:` sites; blocked writer ⇒ hung app) — refuted by
   already-captured evidence: the app's `[Perf]` lines reach the wdio-side
   `driver-*.log`, so that pipe chain IS drained. The post-boot silence is an
   idle app, not a blocked writer.
5. **Log volume** (`RUST_LOG=error`) — same failure.

The break window `8fbb2a86..71a53c38` contains exactly one commit (#424, the
gitstat logging), yet both mechanisms tried for it are refuted. Treat that
single-commit window as an unexplained coincidence, not as evidence.

## What DID get fixed along the way (merged; Ubuntu-verified)

**The suite no longer needs a dev server.** The smoke binary was built with
bare `cargo build`, which omits `tauri/custom-protocol`, so the binary served
`build.devUrl` and the workflow ran a Vite dev server beside it. Build via
`bun run tauri build --debug --no-bundle` instead: frontend embedded, dev
server steps deleted, tier 3 now exercises the shipped asset path.

**Testability seams no longer ride on `import.meta.env.DEV`.** The e2e hooks
(`e2e-navigate` / `e2e-reset-view`, `data-e2e-*` markers, listing/watcher
probes) were gated on DEV, which is what forced the dev-mode binary in the
first place. They now sit behind `E2E_HOOKS_ENABLED`
(`src/lib/domain/e2e-hooks.ts`), set by `VITE_E2E_HOOKS=1` only in the smoke
workflow. Verified in both directions: `e2eHooksReady`/`e2e-navigate` appear 0
times in a normal `bun run build` output and once each with the flag set.

**Timeout calibration.** The Windows debug build is ~12 minutes, so a
25-minute job cap plus a suite-sized step bound killed the job as `cancelled`
with no artifacts. Job cap 40m; the 15m per-step bound is what fails a stuck
run, leaving the `always()` artifact upload alive.

## Transferable lessons

- **Do not hang testability seams off `import.meta.env.DEV`.** "Is this a dev
  build" and "may the tests drive this app" are different questions; conflating
  them drags a whole dev toolchain into the test environment.
- **A harness that needs a dev server beside the binary has a timing
  dependency**, and it will degrade silently as the app grows. Prefer the
  shipped asset path.
- **Bound a hanging failure before theorizing** (`bail` on first session
  failure): "hangs" became "times out at exactly `connectionRetryTimeout`" —
  a different, far more informative fact.
- **Probe, don't run suites.** Every hypothesis here costs a ~12m Windows
  build + suite serially; the actual question ("does `POST /session`
  return?") takes seconds. Build once, fan hypotheses out as parallel matrix
  jobs. A one-commit diagnosis loop at ~27 minutes per bit of information is a
  process bug in itself.
- **Check the boring external causes first** — a driver release, a runner
  image update — before instrumenting the app. Two of five hypotheses died in
  one HTTP request each.

## Where the hunt stands

Everything app-side is exonerated; the failure lives in msedgedriver's attach
(or the runner's WebView2/driver pairing — the runner image updated in the
same July window). Next probes, in order of information value: plain headless
Edge with no app (if that hangs, the runner pairing is broken and the app was
never at fault); msedgedriver spoken to directly with Microsoft's documented
WebView2 capabilities and `--verbose --log-path` for the driver's own account;
the documented "attach" approach via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
remote-debugging-port. A local Windows machine turns each iteration from ~25
CI minutes into seconds.
