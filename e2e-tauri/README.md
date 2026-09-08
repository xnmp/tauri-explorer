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
