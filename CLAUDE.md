# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

| Task | Command |
|------|---------|
| Dev server (frontend only) | `bun run dev` |
| Dev server (full Tauri app) | `bun run start` |
| Clean rebuild | `bun run clean` (full) or `bun run clean:fast` (skip Rust) |
| Type check | `bun run check` |
| Unit tests | `bun run test` |
| Single unit test file | `bunx vitest run tests/path/to/file.test.ts` |
| E2E tests (default view) | `bun run test:e2e` |
| E2E tests (all view modes) | `ALL_VIEW_MODES=1 npx playwright test` |
| E2E tests (WebKit ≈ WKWebView proxy) | `WEBKIT=1 npx playwright test --project=webkit` (on Arch: prepend `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true`; Ubuntu-only libs live in the webkit bundle's `sys/lib`) |
| Single E2E test | `npx playwright test e2e/specific.spec.ts` |
| Tauri-binary E2E (Linux/Windows only) | `bun run test:e2e:tauri` (needs `cargo install tauri-driver`, `webkit2gtk-driver` on Linux, a debug binary, and a dev server on :1420) |
| Performance tests | `bun run test:perf` |
| Rust criterion benches | `bun run bench:rust` (baselines recorded in `src-tauri/benches/*.rs` header comments) |
| Bundle-size budget check | `bun run check:bundle` (builds frontend, fails if main chunk gzip exceeds budget in `scripts/check-bundle-size.mjs`) |
| Rust build only | `cd src-tauri && cargo build` |
| Runnable release binary | `bun run build && cd src-tauri && cargo build --release --features tauri/custom-protocol` — a bare `cargo build --release` yields a DEV-mode binary that dials localhost:1420 (Tauri gates prod on the `custom-protocol` feature, which only the Tauri CLI passes) |
| Rust tests only | `cd src-tauri && cargo test` |

### WSL ↔ Windows: always `git push` after committing

When developing in WSL (e.g. on the `windows` branch), the Windows side builds/tests by pulling from the remote — it does **not** see your WSL working tree. A commit that isn't pushed never reaches the Windows build, so the fix appears to "not work" when it simply never arrived.

## Architecture Overview

**Stack:** Tauri v2 (Rust backend) + Svelte 5 (runes) + TypeScript + Vite 6. Package manager: `bun`.

Frontend layers (`src/lib/`): `domain/` (pure logic, no framework deps — put business logic here), `state/` (rune stores), `api/` (IPC wrappers; `mock-invoke.ts` fakes the backend outside Tauri, detected via `__TAURI_INTERNALS__`), `composables/`, `components/`, `themes/`. Backend (`src-tauri/src/`): all Tauri commands must be `async fn` (sync blocks the main thread). Entry point `src/routes/+page.svelte` composes the layout and owns global shortcuts.

Rules that bite:
- Three view modes (Details/List/Tiles) dispatched by `FileList.svelte` — display features must land in all three.
- Refresh policy is split deliberately: WHEN=`refresh-manager`, WHETHER=`pane-watch`, HOW=`pane-refresh`. Don't add a fourth gate, and don't build private refresh stacks inside components — the git graph did, and it produced #431/#432.
- Keep state machines and caches out of component-local scope (`<script module>` in a `.svelte` file is not a state layer). If it can't be unit-tested through an import, it will eventually be wrong unobserved (#444).

## Documentation

- **Start at [docs/code-map/](docs/code-map/)**: [map-feature.md](docs/code-map/map-feature.md) for cross-layer work and bug hunts, [map-playbook.md](docs/code-map/map-playbook.md) recipes for task-shaped changes (new palette command / context-menu action / Tauri command / setting), [map-folder.md](docs/code-map/map-folder.md) as the exhaustive per-file index. For a small localized change you can already name, skip the maps and grep (measured net loss on cheap tasks; prose architecture docs were deleted for the same reason — see [STUDY.md](docs/code-map/STUDY.md)).
- **Keep the maps current or they turn harmful.** New/moved source file → update `map-folder.md` (+ the `map-feature.md` cluster), then `python3 docs/code-map/validate.py --coverage`. CI runs the same check.
- [docs/lessons_learnt.md](docs/lessons_learnt.md) — gotchas from closed issues; append to it when you fix a bug, search it when you hunt one.

## Issues, Branches, Screenshots

- All development happens off `dev`; feature branches merge back to `dev` with a descriptive squash commit. Don't modify files directly on `dev`. At session start, convert tasks in [@new_todo.md](@new_todo.md) into GitHub issues (plan first; the plan can live in the issue body).
- Branch ↔ issue convention: branch `feat/my-feature` must match an **open GitHub issue** whose title contains `my-feature`; a hook validates this at branch creation. Prefixes: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`.
- Relationship tooling (blocking, sub-issues) is the `jwilger/gh-issue-ext` extension (`gh issue-ext …`).
- Issue bodies need a `## Screenshots` section with checkboxes; files go in `screenshots/<branch>/` and the merge hook verifies they exist. "None required" is only for changes with no user-visible effect; behavioral fixes still need one showing the corrected behavior. Verify a screenshot actually demonstrates the feature before counting it.
- The merge hook does **not** close issues — close them yourself (`gh issue close N --comment`) when the work lands on dev.
- Before ending a session that merged UI work: `ALL_VIEW_MODES=1 npx playwright test`.

## Verification

The three test tiers see different things; pick by what could actually break:

1. **Vitest (`tests/`)** — domain logic and store behavior. The default home for every fix's regression test.
2. **Browser Playwright (`e2e/`)** — UI behavior against `mock-invoke.ts` on :1420. Good for interaction/focus/layout. **Structurally blind to backend timing** (watchers, git, IPC latency), and **circular for new backend features**: if you wrote the mock, the test proves the UI agrees with your own assumption, not with the backend.
3. **Tauri-binary E2E (`e2e-tauri/`)** — WebdriverIO + tauri-driver against the real binary: real Rust, real fs watchers, real git (see `e2e-tauri/README.md`; keep this suite small and reserve it for what genuinely needs the real backend).

Anything whose failure mode involves races, watcher timing, git state, or cache staleness needs tier 3 or a Rust temp-repo test in `src-tauri` — a green mock E2E is not evidence for those.

**Repro-first for bug fixes.** Before changing logic, write the test that fails for the reported reason (or demonstrate the failure at the pre-fix commit). Gold standard: the test passes on your branch and fails with the fix reverted. If the buggy logic has no importable seam, extracting the seam is part of the fix — don't settle for verifying a transcribed copy.

**Adversarial verification for high-risk changes.** Concurrency, caching, perf claims, and anything self-graded by its implementer gets a separate verifier (a subagent with no stake in the claims) that tries to *falsify* each claim — staleness attacks on caches, interleaving attacks on async flows, measured numbers for perf claims — and reports CONFIRMED / PLAUSIBLE / REFUTED per claim. This found real bugs both times it was run; budget for it on any structural change.

**E2E tests assert outcomes**, not existence — a QuickOpen test verifies results appear for a query, not that the modal opened.

## Delegation & Subagent Worktrees

- Agent-tool worktrees are created from **main**, not `dev`: a delegated agent must start by branching from `origin/dev` (or the coordinator's integration branch), and the coordinator verifies `git merge-base` before merging.
- Agents work **only inside their worktree cwd with relative paths**. Absolute paths leak edits into the main checkout — it has happened; coordinators should spot-check `git -C <main-repo> status` while agents run.
- Port :1420 belongs to the main session. Agents needing a dev server or E2E run use their own port with a throwaway config.
- Squash-merge conflicts in `lessons_learnt.md` / `map-feature.md` are usually both-append — resolve as a union, checking for line-level supersedes.

## Debugging

When a bug resists quick diagnosis: search `lessons_learnt.md` and commit history first, then add targeted logging/instrumentation before another fix attempt. Suite-wide test timeouts (~5 s) under parallel/CPU load are a known flake mode — rerun the failing files in isolation before treating them as regressions.
