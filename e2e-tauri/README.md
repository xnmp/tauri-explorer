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
