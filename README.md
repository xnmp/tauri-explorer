# Tauri Explorer

[![CI](https://github.com/xnmp/tauri-explorer/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/xnmp/tauri-explorer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/xnmp/tauri-explorer)](https://github.com/xnmp/tauri-explorer/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A file manager with Ctrl+P, Ctrl+Shift+F, and a command palette.**

If you've ever opened your editor just to move files faster than your file manager lets you, this is for you. Fuzzy quick-open with frecency ranking, ripgrep content search, a palette for every action, rebindable keys, tabs and dual panes, a git commit graph, and a UI you can strip down to nothing. Tauri v2 (Rust) + Svelte 5, native on Linux, Windows, and macOS. No telemetry.

**→ [Try it in your browser](https://tauri-explorer.vercel.app)** — the showcase site is a working copy of the app. Press `Ctrl+P`.

![Details view with sidebar](screenshots/readme/details-view.png)

## Install

Grab the [latest release](https://github.com/xnmp/tauri-explorer/releases/latest) — AppImage/deb/rpm, MSI, or dmg. On Linux it can even [replace your system file picker](https://tauri-explorer.vercel.app) (xdg-desktop-portal FileChooser backend).

```bash
# macOS (Apple Silicon) — --no-quarantine needed until the app is notarized
brew install --cask --no-quarantine xnmp/tap/tauri-explorer

# Arch Linux (repacks the release .deb; source-build PKGBUILD at repo root)
git clone https://github.com/xnmp/tauri-explorer && cd tauri-explorer/packaging/aur && makepkg -si
```

Binaries aren't code-signed yet. Windows shows a SmartScreen warning on first launch. macOS reports un-notarized downloads as "damaged" — install with `--no-quarantine` as above, or clear the flag on an already-installed app: `xattr -rd com.apple.quarantine /Applications/tauri-explorer.app`.

## Building

Requires [Rust](https://rustup.rs/), [Bun](https://bun.sh/), and [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
bun install
bun run start     # dev server
bun run build     # production build
bun run test      # unit tests
bun run test:e2e  # browser e2e
```

## Status

Actively developed — see the [changelog](CHANGELOG.md) and [releases](https://github.com/xnmp/tauri-explorer/releases) for what's new. If you hit a bug: Command Palette → "Report a Bug" (it pre-fills an issue with a local log excerpt — nothing is sent automatically), or [open an issue](https://github.com/xnmp/tauri-explorer/issues/new/choose).
