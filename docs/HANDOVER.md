# Session Handover — as of 2026-07-11 (evening)

Continuing work on tauri-explorer — v1.3.0 is released; the architecture sweep is applied; ready for the next round.

**Previous session summary:** Shipped the **upscale plugin** (#276: right-click JPG/PNG/WebP → SeedVR2 on fal.ai via a Rust queue job; replaced the old session-level skill), made the **floating-islands layout cross-platform** (#277: new `floatingIslands` setting works on Linux with a themed depth-gradient backdrop + apple-design material hierarchy), then ran an **adversarial Fable architecture sweep** and applied it: plugin-scaffolding dedup + domain cleanups (#278), clipboard AppError surfacing (#279), settings/commands behavior tests (#280), tab-display extraction from the window-tabs god store (#281), api/open+system split (#282). Released **v1.3.0** (#283).

**Key context:**
- Verify the v1.3.0 "Build & Release" workflow completed and assets exist: `gh run list --workflow=release.yml` (the PR to main may still have been in flight at session end — check `gh pr list` and merge if needed).
- Gates before release: 984 unit tests, 214 Rust tests, 0 svelte-check errors, full `ALL_VIEW_MODES=1` E2E 524/525 (1 terminal-panel load-contention flake, passes isolated).
- **Sweep findings deliberately deferred** (revisit only when feature work forces the seam): PreviewPane 3-way split (C1), other big-but-cohesive components (C2), mock-invoke behavioral drift vs real git (C3 — grow `e2e-tauri` instead), window-tabs closed-pane-restore extraction (B2 step 2 — the next natural increment; tab-display extraction proved the pattern in `state/tab-display.svelte.ts`).
- **New conventions the sweep established** (enforce in review): plugin dialogs use `plugins/plugin-dialog.css` (`.plugin-dialog` root class) + `domain/available-filename.ts`; Rust plugin jobs use `plugin_job.rs` (ids/validation/timeout/`{prefix}-complete|-error` emission); panel resize via `usePersistedPanelWidth` (no raw localStorage in components); backend commands return `Result<_, AppError>` — bools only for pure probes; `api/open.ts` (external programs) and `api/system.ts` (window/OS plumbing) exist — don't re-fatten files.ts, whose re-exports are now named, not `export *`.
- **Upscale plugin**: `src/lib/plugins/upscale/` + `src-tauri/src/{upscale,fal}.rs`. fal gotchas: scoped keys 403 on documented upload endpoints — use `rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3` → PUT; queue errors arrive as a `detail` array WITH status COMPLETED; min input 128×128. Key in plugin settings or `FAL_KEY` (~/.zshenv).
- **Floating islands**: `floatingIslands` setting → `data-vibrancy` (+ `data-vibrancy-no-blur` when no native backdrop). Island materials: `--vibrancy-island-bg` (content) vs `--vibrancy-island-bg-structural` (sidebar, heavier) vs `--vibrancy-island-filter` (blur; `none` in no-blur/reduced-transparency). The apple-design skill is installed at `~/.claude/skills/apple-design` — load it for any motion/material/typography work.
- `screenshots/_issue-refs/`, `docs/AI-native-ideas.md`, `docs/code-map/` stay untracked — never `git add -A`.
- HANDOVER.md and any tracked doc can't be edited on `dev` — hooks require a chore branch + issue even for docs.

**Current state:** All issues #276–#284 closed; dev pushed; no open branches besides the release PR (if still open). Working tree clean except intentionally-untracked files.

**Next steps:** Confirm the release PR merged + workflow published v1.3.0 assets; then new feature requests → issues → branches per CLAUDE.md.

---

## Architecture & Learnings

### Layering (post-sweep state)
- `domain/` pure (zero state imports — `UndoAction` now lives in `domain/undo-operations.ts`, `extractFolderName` in `domain/tab-title.ts`); `state/` rune-store singletons; `api/` = IPC wrappers with `ApiResult`, now split: files (fs CRUD) / open (external programs) / system (window/OS) / git / search / thumbnails / archive / config; `plugins/` built-ins registered in `plugins/registry.svelte.ts` `BUILT_IN_PLUGINS`.
- `window-tabs.svelte.ts` (~990 lines) still owns tab CRUD, pane trees, restore stacks, persistence, explorer lifecycle; its display/title/git-root decoration lives in `state/tab-display.svelte.ts` (factory taking `{getTabs, getTabLivePath, panePath}` getters — the pattern for further extractions).
- Adding an AI plugin now costs: frontend `plugins/<id>/index.ts` (+dialog importing `../plugin-dialog.css`, root class `dialog plugin-dialog`), one entry in BUILT_IN_PLUGINS, an api wrapper, a Rust module on `plugin_job.rs`, `mod` + `generate_handler!` in lib.rs, and a `start_<id>_job: () => 1` mock.

### CSS zoom + theming
(unchanged — see the recurring-bug-source sections in the previous handover / lessons_learnt: standardized zoom = post-zoom px everywhere, no engine branches; grep themes before using a token; no light-hex var fallbacks.)

### Testing & dev-loop
- Unit: `bunx vitest run --maxWorkers=2` (full-parallel dies with `Unknown system error -122` in sandboxed shells; also caused ONE phantom "37 files failed" run — rerun before believing it). Rust: `cd src-tauri && cargo test`.
- E2E: `rtk proxy npx playwright test --reporter=line` (rtk's parser chokes otherwise); session gate `ALL_VIEW_MODES=1`; terminal-panel spec is the current flake under full-suite load.
- Store tests: `vi.resetModules()` + dynamic import per test for singletons; `vi.mock` the api modules; see `tests/state/{scm-summary-cache,clipboard-os-errors,settings-init,commands-registry}.test.ts`.
- agent-browser: `AGENT_BROWSER_SESSION=<name>`; screenshots to repo-relative `screenshots/<branch>/<name>.png`; `touch` sources if the running Vite server serves stale modules after branch switches; LSP diagnostics can be stale right after a checkout — trust `bun run check`.

### Workflow (hooks)
- Branch ↔ open issue title match; merges `git merge <branch> --no-ff` (branch name first, no `--ff-only` anywhere — sync local branches with `git reset --hard origin/<branch>`); screenshots committed separately and Read before commit; `main` is PR-protected (release = PR dev→main via `gh pr create`/`gh pr merge`); release workflow runs on push to main; bump versions in package.json/Cargo.toml/Cargo.lock/tauri.conf.json/PKGBUILD + CHANGELOG.
