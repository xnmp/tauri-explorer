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
scenario-duration p50/p95, and every scenario result. A failed assertion takes a screenshot named with the seed,
cycle, and scenario, records it in the JSON report, and fails the command.
The required expected-display-scale value makes a DPI qualification leg fail
instead of silently running at the wrong native runner scale.

This runner supports Linux/WebKitGTK and Windows/WebView2. It makes no macOS UI
claim because WKWebView has no supported tauri-driver backend. The real macOS
process gate in `.github/workflows/macos-smoke.yml` runs 30 cold plus
`WARM_MEASURE=1` activation samples, checks post-startup survival, and uploads
its exact-binary JSON report and logs. Those native logs, not browser tests, are
the source for macOS p50/p95 timing qualification.
