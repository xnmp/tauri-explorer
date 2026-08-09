# #457 — Windows Tauri smoke hung because the debug binary needed a dev server

## Symptom

From 2026-07-17 the `windows-latest` leg of `Tauri binary E2E (smoke)` consumed
its whole 25-minute `timeout-minutes` cap on every run. Build steps were green;
only "Run smoke suite (Windows)" hung. `ubuntu-latest` ran the same suite in
8–9 minutes. 20+ consecutive runs, no flake — a hard cliff.

## What the diagnostic run showed

Bounding the run (`bail` after the first session failure) turned the timeout
into a readable failure in 61 seconds:

```
[0-0] [tauri-e2e] spawning driver for ...\target\debug\tauri-explorer.exe
[0-0] [Perf] main() pre-run: 316.6µs          <- the app process DID start
[0-0] Error serving connection: hyper::Error(IncompleteMessage)
✖ Failed to create a session:
WebDriverError: The operation was aborted due to timeout when running
"http://127.0.0.1:4444/session" with method "POST"
```

The app launched. `POST /session` then hung for exactly `connectionRetryTimeout`
(60 s) and WDIO aborted mid-request, which is what tauri-driver's hyper server
reports as `IncompleteMessage`. So the failure was inside the new-session
handshake, not in spawn, not in a spec.

## Root cause

`cargo build --manifest-path src-tauri/Cargo.toml` produces a **dev-mode**
binary. Tauri gates production asset embedding on the `tauri/custom-protocol`
feature, which only the Tauri CLI passes — a bare `cargo build` therefore leaves
the webview pointed at `build.devUrl` (`http://localhost:1420`). The workflow
compensated by starting a Vite dev server next to the binary.

msedgedriver's `POST /session` does not return until the WebView2 page finishes
loading. That load was a **cold** Vite dev server — started one second earlier —
transforming the entire module graph on demand. On the Windows runner that
exceeded 60 s; on Linux it did not. Nothing about Windows was broken. The suite
had a hidden dependency on dev-server cold-start latency, and the module graph
crossed the 60 s line in July.

The Jul 17 break window pointed at the git-graph _spec_ work, which was a red
herring: the git-graph _feature_ work in the same window grew the module graph.

## Fix, part 1 — embed the frontend

Build the smoke binary through the Tauri CLI so the frontend is embedded and no
dev server exists to race:

```bash
bun run tauri build --debug --no-bundle
```

Both dev-server steps were deleted from the workflow. This also removes the
Linux leg's dependency on the same latency, and makes the binary under test
closer to what actually ships.

## Fix, part 2 — decouple the e2e hooks from DEV

Part 1 alone **traded one failure for another**, and the CI run proved it: the
Windows session handshake started succeeding, but every spec on _both_ OSes then
failed with `dev e2e hooks never became ready` and `scratch directory never
rendered`.

The suite does not drive the app through its real UI. Under Xvfb there is no
window manager, so autofocused inline inputs blur and cancel the instant they
open; the specs therefore dispatch `e2e-navigate` / `e2e-reset-view` and poll
`data-e2e-*` readiness markers instead. Every one of those hooks was gated on
`import.meta.env.DEV`, which is `false` in a production asset build.

So the hooks were transitively the _reason_ the suite needed a dev-mode binary,
which is the reason it needed a dev server, which is the reason Windows hung.
The dev-server dependency was a symptom two levels down from the real coupling.

Hooks now sit behind their own explicit build flag, `src/lib/domain/e2e-hooks.ts`:

```ts
export const E2E_HOOKS_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_E2E_HOOKS === "1";
```

The smoke workflow builds with `VITE_E2E_HOOKS=1`. Both operands are statically
replaced by Vite, so a normal build folds the constant to `false` and the
guarded code is tree-shaken out — verified in both directions: `e2eHooksReady`
and `e2e-navigate` appear **0** times in a normal `bun run build` output and
once each with the flag set. Release builds are unaffected.

Two `import.meta.env.DEV` gates were deliberately left alone — the startup-timing
`console.info` and the shortcut-conflict validator are dev diagnostics, not
testability seams.

## Transferable lesson

A test harness that needs a dev server alongside the binary has a **timing**
dependency, not just a setup dependency — it will degrade silently as the app
grows and then fail as a cliff. Prefer the shipped asset path.

More general: **do not hang testability seams off `import.meta.env.DEV`.** "Is
this a dev build" and "may the tests drive this app" are different questions,
and conflating them silently drags a whole dev toolchain into the test
environment. Give the seam its own flag.

Corollary already recorded elsewhere in this repo, now with a second victim:
`cargo build [--release]` never yields a production-mode Tauri binary. If you
did not go through the Tauri CLI, the webview is dialing localhost.

## Diagnosing hangs like this

Do not raise the timeout. Bound the failure instead (`bail` on first session
failure) so the job produces a transcript in ~1 minute rather than burning the
cap; the difference between "hangs" and "times out at exactly
`connectionRetryTimeout`" is the whole diagnosis.
