# Native (Tauri-binary) test rules

Build and run commands are in root `CLAUDE.md`. The native suite's
`bun run check:e2e:tauri` is a CI step of its own, not a Vitest test (#1123).
Native E2E target cache in CI (ADR 0022): `.github/workflows/CLAUDE.md`.
Renderer loss: test harnesses must not reload a crashed WebView themselves; that
would race the product's reload (`src-tauri/src/renderer_owner/CLAUDE.md`).
Real-watcher acknowledgement protocol (#1152): `src-tauri/src/files/CLAUDE.md`.
Incremental typecheck metadata for `check:e2e:tauri`: `tests/CLAUDE.md`.

## Native qualification (ADR 0021)

Native qualification must bind resource sampling to the verified manifest binary, retain run-specific driver output on failures, and normalize Rust `Duration` units before calculating startup percentiles. macOS cold-start attribution correlates native monotonic readiness with browser wall-clock boundaries: retain the residual as `unattributedMs`, keep foreground and warm samples separate, and never describe two animation-frame callbacks as compositor-presented pixels or a Dock bounce. The pre-`run` interval is its own `processEntryMs` phase (main.rs hands `run_with_process_entry` its entry instant); time before `main()` is outside every in-process clock and comes only from the runbook's launch recording. Startup marks belong to one owner: `window-session` records `mount`/`settings-ready`/`commands-ready`, `+page.svelte` only `bundle-exec`/`list-ready`/`app-ready`. `startup-timing` mirrors each recorded main-window mark (plus a bounded heartbeat) as a `Startup(webview-progress)` line; this adds no marks and changes no ownership, and the attributed parser must never read progress lines — only `startup-progress.ts` does, to describe a timeout (#936). One parser serves both the readiness predicate and the report: an independent readiness regex drifted from the emitted log format and would have failed every Mac sample (#696). A timeout reports that parser's last rejection, the last progress mark, and bounded `stall-evidence.ts` captures taken before the app is stopped; a capture failure only adds a clause to the timeout, never replaces it. Reject a residual below -(5ms + 500 ppm × launch total) — the wall-clock slew bound measured in CI (#936) — and any duplicated webview marker rather than publish a plausible decomposition, and let a `missed` measured half-bounce deadline fail the run while `unqualified` stays non-fatal. Interactive Mac evidence is ingested only from inside the qualification root and must match the verified binary SHA-256, hardware model, normal Launch Services method, sample count, and per-sample recording/trace plus functional-frame/input times. Per ADR 0021, raw replay seeds never become path components; signal exits, rejected force-kills, and children still alive after the force timeout fail the run, with process output preserved. WebdriverIO does not turn ordinary `afterSession` rejection into a failing command, so owned-process cleanup errors cross the worker/launcher boundary through run-scoped state checked by `onComplete`.

## WebDriver sessions and probes

- A native WebDriver command can block until WebKitWebDriver deletes the
  session. Diagnose that interval with the bounded Node-side `/proc` sampler in
  `e2e-tauri/diagnostics/process-timeline.ts` only; do not issue another
  WebDriver command. Identify renderers by PID plus start time (not PID alone),
  retain capture errors rather than treating them as process absence, and
  always stop the sampler without changing the original rejection (#703, #781).

WebKitWebDriver may evaluate `browser.execute` in an isolated JavaScript world.
Use DOM events/state to communicate with dev-only application probes; mutating
application globals such as `window.__TAURI_INTERNALS__` from the injected
script can remain invisible to the app even when later injected scripts read
the mutation back. Publish hook readiness and acknowledge each operation with a
unique DOM token before polling its result; repeatedly dispatching an operation
while waiting can queue duplicate real backend work that outlives the poll.
Multi-step WebKit interaction tests must also wait for an opened modal to become
hidden after Escape before focusing the next surface; otherwise the following
shortcut can correctly be rejected while `hasModalOpen` is still true. Keep
clock-exact debounce coverage in fake-timer domain tests: an E2E runner may stall
between synthetic keystrokes for longer than the debounce and legitimately
start an intermediate query, so contract-level final-query tests should update
the input atomically.

Native crop oracles measure loaded first-frame pixels and intrinsic preview
dimensions. Use bounded load/error callbacks rather than an unbounded injected
`Image.decode()` promise, retaining exact pixel assertions. The fake external
CLI's test-only timeout must include cold interpreter startup before reaping;
a deadline that kills it before its PID is written cannot prove child cleanup.

For Windows native transfer waits, use one renderer-side observer through
`executeAsync` to correlate the requested operation token or listing mutation.
Retain failure JSON and screenshots under `e2e-tauri/logs/`, capturing the
failing window before inspecting unrelated windows.

Native Git-watch readiness probes read `e2eGitWatches` by `directoryKey`, the
same key published by `api/git.ts`, not by a native `path.join` result. Normalize
on the runner side before `browser.execute`: its serialized callback cannot
reference imported helpers. Windows backslashes otherwise reject a successfully
acknowledged lease (#1254).

A peek without its own directory lease can still refresh through a root
notification: Windows reports child-directory metadata changes to its watched
parent. Native overflow tests must assert a causal root receipt and fresh rows,
not an elapsed interval of staleness. Touch the evicted directory's metadata
explicitly to exercise that ancestor-notification path on Linux too (#1260).

Native graph fixtures must wait for the reset view's `.file-list` before their
repository is deleted, because reset navigation completes asynchronously.

## Clipboard probes

PR native smoke checks stay Linux-only. New native specs are discovered by the
full WDIO glob on dev-push Windows runs; the scoped `clipboard` dispatch selects
only `context-clipboard.spec.ts`, so it does not qualify every clipboard spec.

Independent Windows native clipboard probes must await PowerShell asynchronously.
The first shell/module launch can exhaust a ten-second subprocess budget; include
startup in the bounded probe budget and preserve scalar code/signal/stdout/stderr
on failure. Node synchronous spawn errors can self-reference through `error`,
and WDIO's own-property JSON serialization then hides the original timeout.
Keep these probes independent of application IPC and never retry a failed
clipboard observation (#1188).

Windows PowerShell 5.1 emits a `ConvertFrom-Json` array as one pipeline object.
Assign it directly to `[string[]]`; wrapping it in `@(...)` nests the array and
casts empty/multiple file paths into one invalid clipboard path (#1202).

The #1194 smoke artifact reached the PowerShell-ready marker, then stalled in
`Get-Clipboard -Format FileDropList` for the full 30-second budget. Read eager
Windows file lists through `e2e-tauri/windows-clipboard-read.ps1` instead: it
opens CF_HDROP directly, enumerates UTF-16 paths with DragQueryFileW and closes
the clipboard in finally. Keep the independent native empty/single/multi-path
oracle in `clipboard-cross-window.spec.ts`; mocked subprocess output cannot
qualify the Win32 adapter. Do not extend the timeout or retry an observation.
