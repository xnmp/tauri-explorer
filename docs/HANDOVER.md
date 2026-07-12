# Session Handover — as of 2026-07-12 evening (v1.3.1 released + distribution prep done)

Continuing work on tauri-explorer — v1.3.1 is released, dev CI is green again, and all automatable wider-audience work is merged. What remains is **user-side actions** (accounts, submissions, Mac testing — see the checklist below) and then promotion.

**Previous session summary:** Two arcs. (1) Released v1.3.1: version bump + CHANGELOG (#320), un-redded dev CI — it had been failing since v1.3.0 with rustfmt drift (#322), clippy ptr_arg (#324), and a real bug (#325): unguarded Tauri `listen()` in `use-file-watchers` whose uncaught error the new #302 crash capture turned into a click-blocking crash-notice toast in E2E; merged PR #321 to main; release workflow published all six assets. (2) Distribution prep: repo hygiene (#327: Cargo metadata, CONTRIBUTING/SECURITY/issue templates, README, GitHub description+homepage), bundle identifier → `io.github.xnmp.tauri-explorer` (#328), AUR -bin PKGBUILD validated with a real makepkg build (#329), winget manifests (#330), Homebrew cask (#331), website version fix (#323).

## USER ACTION CHECKLIST (in order of impact)

1. **Deploy the website** (two changes behind: framed window #286 + v1.3.1 version fix #323):
   `cd website && vercel deploy --prod` (or `!`-prefix it in a Claude session; the permission classifier blocks Claude running it).
2. **Create the Homebrew tap** (blocked for Claude: public-repo creation). The cask is ready at `packaging/homebrew/Casks/tauri-explorer.rb`:
   ```bash
   gh repo create xnmp/homebrew-tap --public --description "Homebrew tap for xnmp's projects"
   git clone https://github.com/xnmp/homebrew-tap && cd homebrew-tap
   mkdir -p Casks && cp <repo>/packaging/homebrew/Casks/tauri-explorer.rb Casks/
   git add -A && git commit -m "tauri-explorer 1.3.1" && git push
   ```
3. **Test on a Mac** (Apple Silicon) — nothing macOS-side has been human-verified this session:
   - `brew install --cask xnmp/tap/tauri-explorer` (after step 2). If it fails on the app name, the assumption to check is `app "tauri-explorer.app"` in the cask — verify the actual bundle name inside the dmg (`hdiutil attach`, `ls /Volumes/tauri-explorer*/`) and fix the cask.
   - Gatekeeper flow: first launch must be right-click → Open (unsigned). Confirm the caveat text matches reality.
   - Smoke the app itself: Ctrl+P / palette / file ops (macOS gets no automated binary E2E — WKWebView has no driver; only unit tests + the macos-smoke boot check cover it).
   - Upgrade note: the next release (with the new bundle identifier) shows as a NEW app to macOS; old `com.explorer.app` webview state won't carry over (window tabs, quick-open frecency reset once — settings DO carry, they live in `~/Library/Application Support/tauri-explorer`).
4. **Publish to AUR** (needs your AUR account + SSH key):
   ```bash
   git clone ssh://aur@aur.archlinux.org/tauri-explorer-bin.git && cd tauri-explorer-bin
   cp <repo>/packaging/aur/{PKGBUILD,.SRCINFO} . && git add -A && git commit -m "1.3.1: initial import" && git push
   ```
   (Validated locally: `makepkg` builds and the package contains bin/desktop/icons/portal/dbus/license.)
5. **Submit to winget** (needs a fork under your account; easiest with wingetcreate, or manually):
   ```bash
   # manual: fork microsoft/winget-pkgs, copy packaging/winget/manifests/x/xnmp/... into it, open PR
   # easier: wingetcreate submit packaging/winget/manifests/x/xnmp/TauriExplorer/1.3.1 --token <gh-pat>
   ```
   Windows-side sanity check first if you can: `winget validate --manifest packaging/winget/manifests/x/xnmp/TauriExplorer/1.3.1`.
6. **Code signing (the big unlock, both platforms):**
   - macOS: enroll in Apple Developer Program ($99/yr) → Developer ID Application cert → add `APPLE_CERTIFICATE`/`APPLE_ID`+notarytool secrets to the repo and signing steps to release.yml (Tauri docs "macOS Code Signing"). Until then every Mac user hits Gatekeeper.
   - Windows: cheapest modern route is Azure Trusted Signing (~$10/mo) or SignPath's free OSS tier. Kills SmartScreen warnings and smooths winget review.
7. **Decide on auto-update** — currently only the daily "new version" banner. `tauri-plugin-updater` needs an updater keypair (`cargo tauri signer generate`) — keep the private key OUT of the repo (GitHub secret); pairs naturally with item 6.
8. **Dependabot PRs #314–#318 are open** (vite 8 major among them) — triage when convenient.

**Current state:** main == v1.3.1 release. dev is ahead by: website fix (#323), handovers, repo hygiene (#327), identifier change (#328), packaging (#329/#330/#331) — all ride the next release (suggest v1.3.2 soon so the new identifier + channels ship). All gates green locally (1050 unit / 228 Rust / 575-576 E2E — `tiles-rename-no-shift` flaked once under full-suite load, passes isolated, same family as the known PTY flake). GitHub CI on dev: CI + macOS smoke green; e2e-tauri Windows job flaked on the terminal PTY round-trip spec (known-flaky subsystem, passed on previous push with identical terminal code) — rerun was in flight at handover time; VERIFY it went green before building on top.

**Next steps (Claude side):** 1) Confirm e2e-tauri rerun green. 2) After user completes the checklist: cut v1.3.2 (identifier + packaging + website fix), update cask/PKGBUILD/winget manifests to 1.3.2 hashes (all three pin per-version URLs+sha256 — every release needs a bump commit in each channel until automated; consider a release-workflow step that regenerates them). 3) Promotion material (memory: VSCode-for-filesystem positioning, Ctrl+P/Ctrl+Shift+F/palette first). 4) Product fast-follows: conflict-dialog keep-both, copy-path action, Ctrl+L binding, JobsPanel progress/cancel.

---

## Architecture & Learnings

### This session's new learnings
- **CI toolchain drift:** CI uses `dtolnay/rust-toolchain@stable`, which advances past local (1.93 local vs 1.97 CI) — fmt/clippy diverge silently. **Check `gh run list --branch dev` at session end**; local gates are not enough. rust job failing <1m = fmt, ~6m = clippy/tests.
- **Crash capture ↔ E2E interaction:** any uncaught browser-mode error becomes a crash file → next-launch notice toast → covers bottom-of-viewport UI → blocks Playwright clicks in specs that reload. Debug via `gh run download <id> -n playwright-report` (failure PNGs in `data/`, traces contain `pageError` entries with full stacks).
- **Vite dev boot order:** `page.goto` resolves before ANY app JS runs (even `hooks.client.ts`) under dev-mode module streaming. E2E specs needing app handlers must wait for `.file-list` first. In prod builds the bundle executes before `load`, so `hooks.client.ts` is early enough for real crash coverage.
- **Bundle identifier facts (verified against tauri-bundler source):** MSI upgradeCode = UUIDv5(DNS, "<productName>.exe.app.x64") — productName-based, NOT identifier; NSIS install identity also productName-based. This app's config/cache dirs are identifier-independent (`dirs::config_dir()/tauri-explorer`). Identifier change only resets webview-profile state (localStorage: tabs, frecency) once.
- **AUR -bin pattern:** makepkg auto-extracts the .deb (ar archive) into $srcdir; `bsdtar -xf data.tar.gz -C $pkgdir usr` in package(). GitHub `releases/download/` + `/raw/<tag>/` URLs both work as sources. Watch sha256sums ORDER — it must match source array order (bit me once).
- **Screenshot-path hook:** branch `fix/foo` → `screenshots/fix/foo/<name>.png` (slash → directory); agent-browser must get exactly that repo-relative path.
- **Windows PTY flake family:** `terminal.spec.ts` round-trip in e2e-tauri (Windows runner) joins `pty_shell_runs_in_cwd_and_emits_output` — PTY output timing under CI load; rerun before believing it.

### Layering & structure (stable)
- `domain/` pure; `state/` rune stores; `api/` split barrels (mock-aware invoke in `api/common.ts`); crash path: `hooks.client.ts` → `installGlobalErrorHandlers` → dedupe → `record_frontend_crash` (mock: localStorage `mockFrontendCrash`, consumed-on-read). No telemetry — no network calls beyond the daily update check + opt-in AI plugins.
- Packaging now lives in `packaging/`: `aur/` (publishable -bin), `winget/manifests/...` (mirrors winget-pkgs layout), `homebrew/Casks/`, plus the existing portal files. Root PKGBUILD stays the CI/local source build.
- Per-issue workflow, gates, and hook quirks: unchanged — see the "Testing & dev-loop" and "Workflow (hooks)" sections of the previous handover (git history of this file, commit b1d53bf).
