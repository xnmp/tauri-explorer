# Tauri-binary E2E (`tauri-driver` + WebdriverIO)

A smoke suite that launches the built Tauri binary and drives it via WebDriver. Complements the Playwright suite in `../e2e/`, which runs against the browser dev server with mocked IPC and cannot catch issues that only surface in the real WebView.

## Platform support

| OS | Supported | Notes |
|---|---|---|
| Linux | yes | Uses WebKitGTK via `webkit2gtk-driver` |
| Windows | yes | Uses WebView2 via `msedgedriver` (matched to installed Edge) |
| macOS | **no** | `tauri-driver` has no WKWebView driver. See project issue tracker. |

## One-time setup

```bash
# Binary: tauri-driver (installs to ~/.cargo/bin/)
cargo install tauri-driver --locked

# Linux only: WebKitWebDriver
sudo apt-get install -y webkit2gtk-driver

# Windows only: msedgedriver must be on PATH (pre-installed on windows-latest CI runners)
```

## Running locally

```bash
# 1. Build frontend + Tauri debug binary
bun run build
cargo build --manifest-path src-tauri/Cargo.toml

# 2. Run the smoke suite
bun run test:e2e:tauri
```

## CI

See `.github/workflows/e2e-tauri.yml`. Runs on `pull_request` and `push` to `dev`/`main` against `ubuntu-latest` and `windows-latest`.

## Adding specs

Specs live in `specs/`. Keep this suite **small** — it's slow (full Tauri build per run) and has more platform-specific flake than the browser Playwright suite. Only add tests here that genuinely need the real binary (native shortcuts, WebView-specific rendering, IPC contract). Prefer Playwright for everything else.
