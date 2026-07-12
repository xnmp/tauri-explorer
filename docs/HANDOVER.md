# Session Handover — as of 2026-07-12 (v1.3.1 released)

Continuing work on tauri-explorer — **v1.3.1 is released**; next is closing the wider-audience gaps (signing, packaging channels, repo polish) and the promotion push.

**Previous session summary:** Released v1.3.1: merged the version bump + CHANGELOG (#320), un-redded dev CI (it had been failing since v1.3.0 shipped — local gates never caught it), merged PR dev→main, and verified the release workflow published all six platform assets. Also fixed the website's stale hardcoded version (1.1.0 → 1.3.1, #323) and produced a wider-audience gap assessment.

**Key context:**
- **CI was red on dev for ~20 runs and nobody noticed** — the previous session's "all gates green" was local-only. Three causes, all fixed: (1) `cargo fmt` drift from the CI runner's newer stable Rust (#322); (2) clippy `ptr_arg` errors in `src-tauri/src/upscale.rs` (#324); (3) a real bug (#325): `useFileWatchers.setup()` called Tauri `listen("directory-changed")` unguarded → `transformCallback` TypeError on every browser/E2E load → the #302 crash-capture recorded it → crash-notice toast overlaid the viewport bottom → blocked context-menu clicks in `folder-thumbnails`/`thumbnail-size` specs. **Always check `gh run list --branch dev` / `gh pr checks` at session end, not just local gates.**
- **#325 fix details:** `listen()` now wrapped in try/catch (same pattern as `state/drives.svelte.ts`); crash capture moved from `+page.svelte` onMount to `src/hooks.client.ts` (client entry — catches init/mount-phase errors too); crash-notice spec now waits for `.file-list` before dispatching its synthetic error (under Vite dev, `page.goto` resolves before ANY app JS runs — the spec had been passing tautologically off the real file-watchers error).
- **v1.3.1 release verified:** tag + GitHub release with deb/rpm/AppImage/dmg/msi/setup.exe, all named as `website/app.js` `DL_ASSET` patterns expect.
- **Vercel deploy of the website is STILL PENDING** (carried over from last session, now two changes behind: framed-window #286 + version bump #323). The permission classifier blocks `vercel deploy --prod`; user must run `cd website && vercel deploy --prod` themselves (or `!`-prefix it in-session).
- **Wider-audience gaps identified (inventory-verified, in rough priority order):**
  1. No code signing/notarization (macOS Gatekeeper + Windows SmartScreen warnings; README admits it). Needs Apple Developer ID + notarization and a Windows cert (or accept warnings for now).
  2. No auto-update — only a once-a-day GitHub-API "new version" banner (`check_for_update`); `tauri-plugin-updater` not installed. Fine for v1, but decide before promoting.
  3. No package-manager channels: PKGBUILD is CI-local only (`source=()` empty — not AUR-publishable as-is); no Homebrew cask, winget manifest, or Flathub.
  4. Repo hygiene: GitHub description says "Tauri Windows Explorer" (stale/wrong), homepage URL unset, no CONTRIBUTING.md / issue templates / SECURITY.md; `Cargo.toml` missing `license` field + `authors = ["you"]`; bundle identifier is generic `com.explorer.app` (changing it later orphans user config dirs — decide BEFORE wide distribution).
  5. Old build artifacts (`*.pkg.tar.zst`, `pkg/`) committed at repo root — unprofessional for a public repo.
  6. No end-user docs beyond the in-app cheatsheet and the website demo (acceptable; README install section exists).
- **Product gaps (candidate fast-follows, from test agents last session):** conflict dialog lacks keep-both/rename; no copy-path context action; no Ctrl+L address-edit binding; plugin JobsPanel lacks progress/cancel; mock `restore_from_trash` is a no-op.

**Current state:** main == v1.3.1 release; dev is ahead of main only by the website version fix (#323) + this handover, which ride the next release. No open issues besides the handover one, no branches with pending work. Working tree clean except intentionally-untracked files (docs/code-map/, docs/AI-native-ideas.md, docs/gotcha-study/, screenshots/_issue-refs/). All local gates AND GitHub CI green as of 582c287.

**Next steps:** 1) User deploys website (`cd website && vercel deploy --prod`). 2) Pick wider-audience gaps to close (suggest: repo hygiene + bundle identifier decision first — cheap and irreversible-if-wrong respectively; then signing). 3) Promotion material (positioning per memory: VSCode-for-filesystem, Ctrl+P/Ctrl+Shift+F/palette first). 4) Optional product fast-follows above.

---

## Architecture & Learnings

### This session's new learnings
- **CI toolchain drift:** CI uses `dtolnay/rust-toolchain@stable` — GitHub's runner stable advances past local (local rustc 1.93 vs CI 1.97); fmt/clippy diverge. When the `rust` job fails fast (<1m) it's fmt; ~6m is clippy/tests. rtk tee logs for local repro live in `~/.local/share/rtk/tee/`.
- **Crash capture interacts with E2E:** any uncaught error in mock mode becomes a crash file → next-launch notice toast → can cover bottom-of-viewport UI and block Playwright clicks. If thumbnail/menu specs start timing out after an error-handling change, screenshot the failure artifact first (`gh run download <id> -n playwright-report`).
- **Vite dev boot order:** `page.goto` resolves at the load event, but under dev-mode module streaming NO app JS (not even `hooks.client.ts`) has run yet. E2E specs that need app handlers must wait for app-interactive (`.file-list`) first. In prod builds the bundle executes before load, so `hooks.client.ts` install is early enough for real crash coverage.
- **Screenshot-path hook:** branch `fix/foo` → `screenshots/fix/foo/<name>.png` (the slash becomes a directory). agent-browser must be given exactly that repo-relative path (hook blocks absolute paths; daemon cwd is the repo so relative works).
- **`gh pr merge` on a checks-pending PR:** merge state shows `UNSTABLE` while checks run but `MERGEABLE` — wait for `CLEAN` before merging release PRs.

### Layering (unchanged from hardening sweep)
- `domain/` pure; `state/` rune stores; `api/` split barrels (mock-aware `invoke` in `api/common.ts` — only positive Tauri detection is latched); plugins via `PluginContext`. Arch-lint: `bun run lint:arch` (strict) + non-blocking edit hook. Known allowlisted debt: `state/git-warm.ts` imports from GitGraphView module context.
- Crash path: `hooks.client.ts` → `installGlobalErrorHandlers()` (error + unhandledrejection) → dedupe → `record_frontend_crash`; mock stores in localStorage (`mockFrontendCrash`), consumed-on-read by `take_crash_report`. Everything local; product promises no telemetry — no network calls.
- SCM/preload/contract-tests details: see git history of this file (previous handover, commit 439a44e) — all still accurate.

### Testing & dev-loop
- Unit `bunx vitest run --maxWorkers=2` (1050); Rust `cd src-tauri && cargo test` (228, PTY test flakes under load); merge-gate automatic (affected+smoke); session gate `ALL_VIEW_MODES=1 npx playwright test`; **plus check GitHub CI on dev before ending a session**.
- CI rust job = fmt --check, clippy `--all-targets --features avif -- -D warnings`, tests. Match it locally before pushing Rust changes.
- Playwright failure artifacts: `gh run download <run-id> -n playwright-report` → `data/*.png` screenshots + trace zips (`unzip`; grep `0-trace.trace` for `pageError`).
- Workflow hooks: `git merge <branch> --no-ff -m ...` (branch name must come first for the screenshot hook); commit and merge as separate Bash calls; branch ↔ open-issue title match enforced.
