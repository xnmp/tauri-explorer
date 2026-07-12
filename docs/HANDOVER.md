# Session Handover — as of 2026-07-12

Continuing work on tauri-explorer — the disciplined-engineering hardening sweep is fully merged; next is the **big release with promotion** (v1.4.0).

**Previous session summary:** A very large hardening session: shipped the website window-margin (#286), git-graph/SCM background preload (#287), full SCM merge-conflict handling with op banner + abort/continue (#294), frontend crash capture + log tail in bug reports (#302), security hardening (#303), tiered E2E gating with @smoke + affected-by-diff merge hook (#298), non-blocking arch-lint hook (#304), mock↔backend contract tests (#299), criterion/bundle perf guards (#300), E2E coverage tiers 1–3 + git-graph action tests (#288/#295/#296/#297), a11y-to-zero + CLAUDE.md code-map docs + dependabot (#301). Also produced an adversarial architecture re-review (4 fixes merged: plugin seam #291, layering #292, row-grid composable #293, lazy dialogs #290, dir-scan perf #289), a whole-app security audit (no crits/highs), and a regression-effectiveness report (artifact: https://claude.ai/code/artifact/616afd80-b40f-4ce5-aa49-5486bfda160e).

**Key context:**
- **Gates on final dev (23f6dbc):** 571/571 E2E `ALL_VIEW_MODES`, 1050 unit, 228 Rust (+1 known PTY flake `pty_shell_runs_in_cwd_and_emits_output` — fails only under full-suite load, passes isolated), `bun run check` 0 errors 0 warnings, `bun run lint:arch` clean.
- **Release prep still to do:** bump versions (package.json/Cargo.toml/Cargo.lock/tauri.conf.json/PKGBUILD + CHANGELOG) to v1.4.0, PR dev→main (`gh pr create`/`gh pr merge` — main is PR-protected), release workflow runs on push to main. CHANGELOG has a LOT to say this time — mine the merged issue list #286–#304.
- **Vercel deploy of the website is STILL PENDING** — the permission classifier blocks `vercel deploy --prod` in auto mode. User must run `cd website && vercel deploy --prod` themselves (or `!`-prefix it in-session). The framed-window change (#286) is merged but not live.
- **New gating machinery:** merges to dev now run affected-specs-in-full + @smoke-on-rest (41 tags, ~37s) via `.claude/hooks/run_e2e_for_merge.sh` + `scripts/e2e-affected.mjs`; falls back to full suite on unmappable changes. The affected script reads `docs/code-map/map-feature.md` (untracked!) — safe ALL fallback where missing. Session-end gate stays `ALL_VIEW_MODES=1 npx playwright test`.
- **New local perf guards (NOT CI, user's explicit choice):** `bun run bench:rust` (baselines recorded in src-tauri/benches/*.rs headers: scan 10k = 5.75ms, git_status = 424µs, sort 10k = 1.40ms) and `bun run check:bundle` (budget 239,791B gzip, 90.9% used).
- **Arch-lint:** `bun run lint:arch` (strict) / non-blocking PostToolUse hook warns on layering violations. Known allowlisted item worth fixing: `state/git-warm.ts` imports `warmGraphSnapshot` from GitGraphView.svelte module context — proper fix is moving the graph snapshot cache into `state/`.
- **Product gaps discovered by test agents (candidate release-blockers or fast-follows):** conflict dialog has NO keep-both/rename option (only Replace/Skip); no copy-path context action; no Ctrl+L binding (address edit is click-only); plugin JobsPanel has no progress/cancel affordance; mock `restore_from_trash` is a no-op so trash-undo isn't E2E-testable.
- **User feedback locked in this session:** parallel agents OK for read-only investigation when asked; implementation agents run ONE AT A TIME with capped workers (memory, not just tokens — the user killed an 8-agent fleet). Avoid the word "unusually" in assessments; be concrete.

**Current state:** All issues #286–#304 closed; dev pushed (23f6dbc); working tree clean except the intentionally-untracked files (docs/code-map/, docs/AI-native-ideas.md, docs/gotcha-study/, screenshots/_issue-refs/). No open branches. Version files still say v1.3.0.

**Next steps:** 1) Have the user deploy the website. 2) Version bump + CHANGELOG + PR dev→main → release v1.4.0; verify release workflow assets. 3) Promotion material (positioning per memory: VSCode-for-filesystem, Ctrl+P/Ctrl+Shift+F/palette first). 4) Optional fast-follows from the product-gap list above.

---

## Architecture & Learnings

### Layering (post-hardening state)
- `domain/` pure (owns GitFileEntry/GitStatusCode/ContentSearchResult now; zero api/state imports — enforced by arch-lint); `state/` rune stores (no component imports; sidebar-view components live in `components/sidebar-view-registry.ts`); `api/` split barrels, named re-exports only; plugins route through `PluginContext.workspace` + `openSettings` (documented exceptions: theme-from-image theme stores, ai-rename suggestion provider, nano-banana legacy key migration).
- List/Tiles share `composables/use-row-grid-view.svelte.ts` (lazy getters preserve rune reactivity); DetailsView intentionally per-row FileItem.
- SCM: `GitStatusSummary.op_state` (`clean|merge|rebase|cherry_pick|revert` from `repo.state()`); commit guarded on `index.has_conflicts()`; `git_discard` refuses conflicted paths (was a silent file-delete data-loss bug); abort/continue commands in git_actions.rs (`GIT_EDITOR=true` for rebase --continue). Banner in ScmSidebarView (`.op-banner`).
- Preload: `gitWarmer` (state/git-warm.ts + pure domain/git-warm.ts scheduler, 250ms debounce, once per repo/session) fills GitGraphView module `graphCache` + `scmStore.summaryCache` from ExplorerPane's currentPath effect.
- Crash: webview error/unhandledrejection → `record_frontend_crash` → same crash-file + next-launch notice as Rust panics; Report-a-Bug appends log tail (URL ≤6000 chars); everything local/opt-in (product promises no telemetry — do not add network calls).
- Contract tests: `tests/contract/fixtures/*.json` consumed by both vitest (mock) and `include_str!` Rust tests — extend fixtures when changing IPC semantics, or drift returns.

### Testing & dev-loop
- Unit `bunx vitest run --maxWorkers=2`; Rust `cd src-tauri && cargo test` (PTY test flakes under load — rerun isolated before believing it); merge-gate is automatic; session gate `ALL_VIEW_MODES=1 npx playwright test` (571 tests, ~4.3m).
- Worktree agents: base off main → `git merge origin/dev` first; `bun install` in worktree; scratch playwright config on `DEV_PORT=<4189+>`; never port 1420. Locked worktrees need `git worktree unlock` then `remove -f -f`.
- Long-running vite on 1420 wedges into blank-page `effect_orphan` after branch switches — restart the server, don't debug the branch.
- Screenshot hook wants repo-relative `screenshots/<branch>/<name>.png`; compound `commit && merge` commands get pre-checked by the screenshot hook before the commit exists — run commit and merge as separate Bash calls.
- agent-browser: text selectors can be ambiguous (`text=Documents` matches sidebar+list) — drive rows via `dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))` in an eval IIFE; `press Control+Alt+g` works for app shortcuts.
- rtk cargo-test log paths land in `~/.local/share/rtk/tee/` — grep there for failure details; a failed `&&` chain leaves the shell cwd wherever the failure happened (check cwd when "No tests found").

### Workflow (hooks)
- Branch ↔ open issue title match; issues need `## Screenshots` section; merges `--no-ff` from dev checkout; merge hook runs affected+smoke; `main` PR-only; screenshots committed on the feature branch BEFORE merging; issue auto-close on merge usually works (close manually with a comment when it races).
