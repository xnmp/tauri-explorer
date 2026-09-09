# Tauri-binary E2E (WebdriverIO)

A smoke suite that launches the built Tauri binary and drives it via WebDriver. Complements the Playwright suite in `../e2e/`, which runs against the browser dev server with mocked IPC and cannot catch issues that only surface in the real WebView.

## Platform support

| OS      | Supported | Notes                                                              |
| ------- | --------- | ------------------------------------------------------------------ |
| Linux   | yes       | Uses `tauri-driver` + WebKitGTK                                    |
| Windows | yes       | Attaches `msedgedriver` to WebView2 through an E2E-only CDP port   |
| macOS   | **no**    | `tauri-driver` has no WKWebView driver. See project issue tracker. |

## One-time setup

```bash
# Linux only: tauri-driver (installs to ~/.cargo/bin/)
cargo install tauri-driver --locked

# Linux only: WebKitWebDriver
sudo apt-get install -y webkit2gtk-driver

# Windows only: download msedgedriver matching the installed WebView2 runtime
# and set TAURI_NATIVE_DRIVER to its full path.
```

## Running locally

```bash
# 1. Build the Tauri debug binary with the frontend + e2e hooks embedded
VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle

# 2. Run the smoke suite
bun run test:e2e:tauri
```

Linux tests that assert native window state need a window manager, not only an
X server. Tiling compositors can ignore maximize requests for grouped Xwayland
clients. Use an isolated display for reproducible maximize/restore acceptance:

```bash
# Debian/Ubuntu prerequisites: xvfb openbox x11-utils
xvfb-run -a --server-args="-screen 0 1280x1024x24" \
  bash e2e-tauri/with-window-manager.sh bun run test:e2e:tauri
```

The wrapper waits for the owned manager to advertise readiness and retires it
after the test command exits. Run it under `xvfb-run`, not on your working desktop.
CI uses the same fixture; unsupported compositor behavior must not weaken native
state assertions or be inferred merely from a failed assertion.

Build through the Tauri CLI, **not** `cargo build`. A bare cargo debug build
omits the `tauri/custom-protocol` feature, so the binary serves `build.devUrl`
(localhost:1420) and the suite silently depends on a Vite dev server running
alongside it. `--debug` embeds the frontend, so the suite exercises the shipped
asset path with no dev server in the loop. The suite's test hooks are compiled
in with `VITE_E2E_HOOKS=1` at build time (see `src/lib/domain/e2e-hooks.ts`);
without it every spec fails with "dev e2e hooks never became ready".

Windows additionally builds with `--features e2e-webview2-attach`, sets
`VITE_E2E_NO_WARM_PRIME=1`, and runs with `TAURI_NATIVE_DRIVER` pointing to a
driver that matches the WebView2 runtime. That Cargo feature is intentionally
absent from release builds: it is the only path that exposes a CDP port.

When isolating Linux runs with XDG variables, keep `XDG_DATA_HOME` on the same
filesystem as the file-operation fixtures (which live under the user's home).
A profile under a tmpfs `/tmp` forces Freedesktop trash to look for a separate
filesystem-root trash directory, which may be unwritable. Use a disposable
profile under the home filesystem; never repurpose `HOME` to redirect tests.
The suites currently share persisted settings when they share one profile, so
use a fresh profile when qualifying a scenario that requires default settings.

## CI

See `.github/workflows/e2e-tauri.yml`. Runs on `pull_request` and `push` to
`dev`/`main` against both `ubuntu-latest` and `windows-latest`.
`docs/lessons/457-windows-tauri-smoke-hang.md` records why the Windows harness
must use the programmatic CDP attach path.

## Adding specs

Specs live in `specs/`. Keep this suite **small** — it's slow (full Tauri build per run) and has more platform-specific flake than the browser Playwright suite. Only add tests here that genuinely need the real binary (native shortcuts, WebView-specific rendering, IPC contract). Prefer Playwright for everything else.


`warm-window-lifetime.spec.ts` verifies real warm reuse, acknowledged navigation,
fresh fallback after rejected activation, and retirement after a claimer closes
without dispatching. Its abandoned-claim case exercises the production 30-second
lease expiry; retain that native outcome instead of replacing it with a browser
mock or shortened test-only timeout.


`git-watch-window-lifetime.spec.ts` acquires a raw acknowledged Git lease in a
child without a frontend cleanup owner, destroys that native window, and checks
the worker's reclamation diagnostic for the unique repository while the main
window remains functional. It needs the default app Info logging. Rust service
and mock-window tests separately cover observer drops, shared coverage, recycled
labels, queued acquisition and registration racing destruction. This is native
window destruction coverage, not renderer-crash recovery or OS watch-FD drainage.


`git-watch-renderer-crash.spec.ts` is Linux-only. It matches the exact application
executable and isolated `XDG_CONFIG_HOME`, kills only that process's descendant
WebKit renderers, then checks repository-qualified worker reclamation while the
native process stays alive. The blank phase issues no DOM or WebDriver commands.
WebKitWebDriver deletes its automation session when the renderer crashes, so this
spec cannot assert recovery of the same application. The normal reload scenario
in `git-watch-window-lifetime.spec.ts` separately exercises renewed ownership and
real mutation delivery; it must not be presented as crash-recovery acceptance.

## Linux renderer-recovery acceptance

This opt-in acceptance harness is the controlled test for renderer recovery. It
requires Python 3.9+ and Linux pidfd support, so renderer signals use pinned process
handles instead of reusable numeric PIDs. Build
the debug binary with the test feature and embedded hooks:

```bash
VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle --features e2e-renderer-recovery
```

Run it under the existing isolated Xvfb/openbox wrapper:

```bash
xvfb-run -a --server-args="-screen 0 1280x1024x24" \
  bash e2e-tauri/with-window-manager.sh bun run test:e2e:recovery
```

The runner retains one native GTK WebView and one application PID while it drives
two actual WebKit renderer `SIGKILL` cycles. WebDriver cannot perform this check:
its session dies with the renderer, so the controller reloads the same retained
view and verifies each fresh JavaScript realm. Acceptance requires fresh
repository-qualified Git leases, rejection of old-generation acquisition, and
preservation of the new lease after a stale release. A real watcher receipt must
contain the exact marker path and a backend observation time at or after the
filesystem write began; the expected repository listing verifies navigation.

Each run uses isolated runtime directories and writes the protocol state, native
application log, and final recovery screenshot there (the runner copies the
screenshot into the branch's evidence path on success). This is controlled test
reload coverage; it does not ship automatic crash-recovery behavior and is not a
Windows or macOS acceptance path.

## Native shared file-history acceptance

`file-history-lifetime.spec.ts` runs on Linux when `TAURI_E2E_HISTORY_GATE_DIR`
is set. It uses the same `e2e-renderer-recovery` build above, an isolated
`XDG_CONFIG_HOME`, and a writable, empty gate directory shared by the runner
and application. For example, with the isolated XDG profile already configured:

```bash
history_gate_dir=$(mktemp -d)
TAURI_E2E_HISTORY_GATE_DIR="$history_gate_dir" \
  xvfb-run -a --server-args="-screen 0 1280x1024x24" \
  bash e2e-tauri/with-window-manager.sh bun run test:e2e:tauri \
  --spec e2e-tauri/specs/file-history-lifetime.spec.ts
```

The runner records real precreated rename effects through the production history
port. A native gate pauses only after the history reservation is admitted and
before the actual filesystem inverse. External tokened release lets the test
close the invoking window while the accepted task remains held. Exact file
contents and passive peer history summaries establish the outcome. This isolates
inverse ownership; it does not establish forward mutation/history atomicity or
native-process crash recovery. The barrier and DOM probes are absent from normal
builds. A gate timeout fails the test instead of proceeding with an unobserved
filesystem operation.

`file-forward-history.spec.ts` uses the same opt-in build and gate directory.
It performs real pane renames: native Undo is visible while renderer result
publication is held, one Undo consumes that entry without a duplicate, and a
successful exact same-name rename preserves an existing Redo. A forward gate
(`next-forward.arm`, matched to its fixture parent) also admits a child rename
before native window destruction; external release then verifies exact committed
bytes and the survivor's actual listing. The child's local history intentionally
retires, so this is accepted forward-work lifetime coverage, not shared local
Undo persistence or recovery after native-process termination.


The `file-forward-history` acceptance suite additionally gates a complete
multi-file trash intent, destroys the native child before releasing it, and
checks both actual removals and the surviving main-window listing. Its paired
`native-delete-batch-before.png` / `native-delete-batch-after.png` screenshots
show that exact listing transition. It retains the local-owner retirement
policy; this is not evidence of process durability or transferable child Undo.

`file-recovery.spec.ts` requires both the `e2e-renderer-recovery` and
`durable-copy-recovery` build features and
`VITE_E2E_HOOKS=1`. Run it with an isolated XDG profile and a fresh, existing
`TAURI_E2E_FILE_RECOVERY_DIR` directory, then select it using
`bun run test:e2e:tauri --spec e2e-tauri/specs/file-recovery.spec.ts` under the
Xvfb/window-manager wrapper above. Keep warm-window priming disabled in that
profile's settings. The test-only setup creates `replacement/` exclusively;
reusing the fixture fails rather than replacing prior evidence. Ordinary builds
contain neither the seed nor channel receipts.

The seed uses the real Coordinator, ownership reservation and replacement
executor to publish a copied file while retaining its original, then drops its
owner. The suite clicks Inspect/Restore in the actual dialog and reads both
payloads from disk. Raw probe subscriptions deliberately omit frontend cleanup.
Native registration IDs (not reusable JavaScript callback IDs) associate channel
send/drop receipts in `channels.jsonl` with exact window/session/token requests.
Two reloads and direct native child destruction must release those channels;
fresh subscriptions must receive the generation advanced by real inspection.
This suite does not establish renderer-crash cleanup, interrupted registration,
power-loss durability or other platforms.

The suite also creates a separate ordinary overwrite through the production
transfer/API/command path. It selects the newly journaled operation by its returned
ID, cycles actual Explorer Undo/Redo twice with recovery Inspect between every
effect, then restores through the dialog. It checks original, source and privately
retained copied bytes and the native completion toasts. The probe forces overwrite and bypasses clipboard/conflict
UI; it does not qualify those interactions. `native-production-copy-restored.png`
records the restored native result. The earlier fixture case additionally renames
its restored target and back through Explorer, verifying refreshed listing names.

The companion `test:e2e:recovery` retained-WebView runner also seeds that fixture.
It requires two externally killed renderers, observes each native recovery Channel
drop before reloading the retained WebView, rejects old-session requests, and
checks new durable-generation callbacks afterward. Its external verifier reads
both surviving payloads and the ordered native channel receipts. The final image
is `native-recovery-channel-crash.png`; logs establish cleanup, while the image
establishes post-crash navigation and selection. In-flight initial subscription
and action interruption at real IPC boundaries remain separate acceptance work.


For replacement command waiter-loss acceptance, also set
`TAURI_E2E_HISTORY_GATE_DIR` to a fresh existing directory in the isolated fixture.
The fifth recovery case arms the native history admission barrier for a child-local
overwrite Undo, destroys that child, confirms its raw Channel dropped, then releases
work externally. The surviving renderer must receive the exact operation's newer
recovery generation and show the restored 24-byte listing; target/source/private
copy bytes are checked directly. Its own Undo/Redo IDs must remain unchanged and
busy must clear: child-local history is deliberately retired, not transferred.
The case also inspects the retained operation after completion. Without the gate
directory this case is skipped. `native-production-copy-redone.png` shows the normal
Redo toast; `native-replacement-detached-undo.png` shows the refreshed surviving
listing. This does not prove power loss or same-label renderer reactivation.


The sixth and seventh recovery cases exercise the production ordered copy session
through `copyFiles` and the actual conflict dialog. A mixed ordinary/replacement
selection is undone/redone twice after its original sources are removed. A separate
prefix/conflict/suffix selection clicks Cancel, verifies only the prefix was copied,
and removes that prefix with one Undo. Both assert real filesystem bytes, with
`native-ordered-copy-redone.png` and `native-ordered-copy-cancelled.png` recording the
visible results. These cases qualify Linux session/UI integration; browser tests
separately cover clipboard selection across Details, List and Tiles.


`file-move-recovery.spec.ts` additionally checks Linux native move admission through
in-app cut/paste and two actual Undo/Redo cycles, asserting both source disappearance
and destination bytes in each direction. Its existing cross-filesystem case still
asserts retained readable source data and no unsafe inverse after source cleanup
failure. `native-admitted-move-redone.png` records the successful final Redo. The
Xvfb run may report an unavailable host clipboard provider; these operations use
the application's clipboard and do not qualify platform clipboard integration.

### Durable copy release policy

Ordinary release builds leave `durable-copy-recovery` disabled until native
artifact retirement is implemented (#687). Staged overwrite copies retain their
previous replacement behavior and exact Linux publication receipts; they do not
retain the displaced original for durable Undo. Existing journal discovery and
explicit recovery stay available.

The recovery-copy acceptance build must explicitly opt in:

```sh
VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle --features e2e-renderer-recovery,durable-copy-recovery
```

Keep ordinary native smoke builds without `durable-copy-recovery` so the default
shipping path is also exercised. `e2e-renderer-recovery` does not imply the feature.
## Extended native qualification soak

The hours-long qualification suite is deliberately opt-in and is not selected
by `test:e2e:tauri` or the pull-request smoke workflow. Start from a clean
worktree and build through the qualification wrapper so the source commit and
profile are tied to the exact binary hash in `qualification-results/native-build.json`:

```bash
bun run build:native:qualification
SOAK_DURATION_MS=14400000 \
SOAK_MAX_CYCLES=500 \
SOAK_SEED=release-1.8.1-linux \
SOAK_EXPECTED_DISPLAY_SCALE=2 \
bun run test:e2e:tauri:soak
```

Omit `SOAK_MAX_CYCLES` to run for the full duration. A bounded harness check can
set `SOAK_MAX_CYCLES=1`; that still launches the real application and exercises
every scenario once. The deterministic seed rotates scenario/interruption order
and is written into the report so a failing order can be replayed.

Reports are written under `qualification-results/` and contain the exact commit,
verified build profile and binary SHA-256/size/mtime, OS/release/architecture,
WebView user agent, display scale, configuration, RSS baseline/final/peak,
scenario-duration p50/p95, and every scenario result. A failed assertion takes a
screenshot named with the seed-derived safe component, cycle, and scenario,
records it in the JSON report, and fails the command.
The required expected-display-scale value makes a DPI qualification leg fail
instead of silently running at the wrong native runner scale.

The report retains `SOAK_SEED` exactly for replay and ordering. Artifact names
use a bounded readable form plus a hash, and the runner rejects any resolved
report, log, or screenshot directory outside `qualification-results/`.

This runner supports Linux/WebKitGTK and Windows/WebView2. It makes no macOS UI
claim because WKWebView has no supported tauri-driver backend. The real macOS
process gate in `.github/workflows/macos-smoke.yml` builds with
`NATIVE_QUALIFICATION_PROFILE=release NATIVE_QUALIFICATION_E2E_HOOKS=0` and runs
30 foreground-only samples (`MAC_STARTUP_WARM_MEASURE=0`) followed by 30 separate
warm-probe samples (`MAC_STARTUP_WARM_MEASURE=1`). Both scenarios verify the same
binary hash, check post-startup survival, and upload reports/logs under
`qualification-results/macos-startup/{foreground,warm-probe}/`. The qualifier
enables release stdout logs explicitly and removes the native warm-probe variable
for foreground-only runs. These are fresh processes with uncontrolled OS caches;
native readiness timing does not establish a presented frame, first input or the
Dock half-bounce target.
