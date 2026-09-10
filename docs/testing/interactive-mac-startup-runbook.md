# Interactive Mac startup qualification runbook

The automated `macOS Smoke` job measures native readiness from process logs on a
shared hosted runner. It cannot observe the things the half-bounce target is
actually about: Launch Services and the Dock, cache state, focus, presented
pixels, or whether a real keystroke did anything. Those require a person at an
identified Mac.

This runbook produces the evidence JSON that
`buildInteractiveMacStartupQualificationReport` ingests, so a half-bounce claim
rests on externally observed outcomes rather than on the app grading itself.

**Until this runbook has been executed on an identified Mac, the half-bounce
target is UNMET and unverified.** The report says so on its own: with no
`halfBounceDeadlineMs` and no observed frame or verified input, `halfBounce`
reports `status: "unqualified"`, never a pass.

## What each recorded phase means

`parseAttributedMacStartupLog` splits a launch into phases that are measured,
never inferred. Wall-clock correlation is used only at the two cross-runtime
boundaries (native window → document boot, and webview ready → readiness IPC
receipt); whatever the correlated clocks cannot explain stays in
`unattributedMs` and is never redistributed.

| Phase                   | Interval                                                   | Owner                    |
| ----------------------- | ---------------------------------------------------------- | ------------------------ |
| `processEntryMs`        | `main()` entry → `run()`                                    | argument parsing, detach |
| `nativeWindowMs`        | `run()` → native window built                               | Rust setup + Tauri       |
| `frameworkNavigationMs` | window built → `app.html` head script (document boot)       | WebView navigation       |
| `documentBootMs`        | head script → app bundle executes                           | asset load + parse       |
| `requiredAppWorkMs`     | bundle exec → settings, commands and the initial listing    | application              |
| `frameSchedulingMs`     | required work done → second animation-frame callback        | renderer scheduling      |
| `readinessIpcMs`        | webview `ui-ready` → Rust receipt of the readiness command  | IPC                      |
| `unattributedMs`        | the residual of `launchTotalMs` against the phases above    | nobody — retained as-is  |

`launchTotalMs` is `processEntryMs + readinessTotalMs`: the whole in-process
window. Time before `main()` (`exec`, dyld, Launch Services) is **outside every
in-process clock** and is exactly what the launch recording below supplies.

Two animation-frame callbacks are a readiness signal, not proof that the
compositor presented pixels. Never describe them as a first frame or a bounce.

## Prerequisites

- A Mac you can identify: record `sysctl -n hw.model`, the macOS version and
  chip. The evidence is rejected if `hw.model` differs from the running host.
- The exact binary from `bun run build:native:qualification` (CI uses
  `NATIVE_QUALIFICATION_PROFILE=release`, `NATIVE_QUALIFICATION_E2E_HOOKS=0`).
  Ingestion rejects evidence whose `buildSha256` is not the verified binary's.
- A screen recording tool that timestamps frames (QuickTime screen recording at
  a known frame rate, or `screencapture -v`). Record the Dock, not just the app.
- A native trace for the input outcome: Instruments (Time Profiler or Core
  Animation) or `log stream --predicate 'process == "tauri-explorer"'`.

## Procedure, per sample

Run at least 10 samples. Keep every sample's conditions identical and stated.

1. **Fix the cache state.** Either reboot before each sample (`cold launch after
   reboot`) or run a fixed number of warm-up launches first — whichever you do,
   write it verbatim into `cachePolicy`. "Uncontrolled" is an acceptable honest
   answer; a wrong answer is not.
2. **Start the recording** with the Dock visible and the app not running.
3. **Launch through Launch Services** — click the Dock or Finder icon, or
   `open -a "Tauri Explorer"`. Do not spawn the binary directly: that skips the
   Dock and the bounce entirely, which is why `launchMethod` must be
   `launch-services-normal-application-launch`.
4. **Press a key with a visible outcome** as soon as the window looks usable —
   e.g. `Cmd+P` (Quick Open) — and keep pressing until it takes effect. The
   first press that produces its result is the verified input outcome.
5. **Stop the recording**, and collect for this sample:
   - the app log for the launch (the `Startup(native-window)`,
     `Startup(webview)` and `Startup(native-ready)` lines must all be present);
   - the launch recording;
   - the native trace covering the keystroke.
6. **Read two times off the recording**, both measured from the same origin —
   the frame in which the Dock icon begins its bounce:
   - `firstFunctionalFrameMs`: the first frame showing the file list rendered
     with real entries. A blank or chrome-only window does not count.
   - `inputReadyMs`: the frame in which the keystroke's result is visible.
7. **Read the Dock half-bounce deadline** off the same recording: the elapsed
   time from bounce start to the midpoint of the first bounce, on this machine.
   It is a measured property of the Mac, not a constant to assume.

## Evidence file

Write one JSON file **inside the qualification root** (default
`qualification-results/`), alongside the logs, recordings and traces it names.
Paths are resolved through `realpath` and must land inside that root, so a
symlink cannot reference evidence the run does not retain for review.

```json
{
  "buildSha256": "<sha256 of the verified binary>",
  "hardwareModel": "<sysctl -n hw.model>",
  "launchMethod": "launch-services-normal-application-launch",
  "cachePolicy": "cold launch after reboot; no warm-up launches",
  "focus": "frontmost application; no other app activated during launch",
  "visibility": "Dock bounce and first functional frame recorded at 60fps",
  "halfBounceDeadlineMs": 450,
  "samples": [
    {
      "log": "qualification-results/macos-interactive/sample-01.log",
      "launchRecording": "qualification-results/macos-interactive/sample-01.mov",
      "nativeTrace": "qualification-results/macos-interactive/sample-01.trace",
      "firstFunctionalFrameMs": 700,
      "inputReadyMs": 810
    }
  ]
}
```

`cachePolicy`, `focus` and `visibility` are free text but must be non-empty:
they are published verbatim in the report as the conditions the numbers hold
under. Every timing must be a non-negative finite number, the deadline must be
positive, and `samples` must contain exactly `MAC_STARTUP_SAMPLES` entries.

## Producing the report

```sh
MAC_STARTUP_SAMPLES=10 \
MAC_STARTUP_INTERACTIVE_EVIDENCE=qualification-results/macos-interactive/evidence.json \
NATIVE_BUILD_MANIFEST=qualification-results/native-build.json \
MAC_STARTUP_OUTPUT_DIR=qualification-results/macos-interactive \
bun run test:qualify:macos-startup
```

The interactive scenario forces `MAC_STARTUP_WARM_MEASURE=0`; combining it with
the hidden warm-window probe is refused, because that probe adds work and
ownership that would contaminate a foreground-only distribution.

`report.json` records the verified build identity and hardware, the stated
conditions, per-phase p50/p95 including `unattributedMs`, and a `halfBounce`
verdict of `qualified`, `missed` or `unqualified`. `qualified` is only reachable
when **every** sample carries an observed functional frame and a verified input
outcome and the p95 of `max(firstFunctionalFrameMs, inputReadyMs)` meets the
measured deadline. Incomplete evidence reports `unqualified`, never a pass.

Attach `report.json`, the recordings and the traces to the issue. Ingestion
contracts are covered by `tests/qualification/interactive-mac-startup-evidence.test.ts`.

## Linux proxy (what it is and is not)

`scripts/qualify-macos-startup.ts` refuses to run off macOS by design. A Linux
run of the same binary through the same parser is useful only for finding
**platform-independent** critical-path work — synchronous work before the
listing, redundant IPC round trips, blocking config reads. WebKitGTK is not
WKWebView, there is no Dock, and a Linux number is never evidence for a macOS
claim or a half-bounce verdict.
