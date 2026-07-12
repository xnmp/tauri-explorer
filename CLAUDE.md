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
| Tauri-binary E2E smoke (Linux/Windows only) | `bun run test:e2e:tauri` (needs `cargo install tauri-driver` and a built binary) |
| Performance tests | `bun run test:perf` |
| Rust criterion benches | `bun run bench:rust` (baselines recorded in `src-tauri/benches/*.rs` header comments) |
| Bundle-size budget check | `bun run check:bundle` (builds frontend, fails if main chunk gzip exceeds budget in `scripts/check-bundle-size.mjs`) |
| Rust build only | `cd src-tauri && cargo build` |
| Runnable release binary | `bun run build && cd src-tauri && cargo build --release --features tauri/custom-protocol` — a bare `cargo build --release` yields a DEV-mode binary that dials localhost:1420 (Tauri gates prod on the `custom-protocol` feature, which only the Tauri CLI passes) |
| Rust tests only | `cd src-tauri && cargo test` |

### WSL ↔ Windows: always `git push` after committing

When developing in WSL (e.g. on the `windows` branch), the Windows side builds/tests by pulling from the remote — it does **not** see your WSL working tree. After committing a change you want verified on Windows, **`git push`**. A commit that isn't pushed will not reach the Windows build, so the fix appears to "not work" when it simply never arrived.

## Architecture Overview

**Stack:** Tauri v2 (Rust backend) + Svelte 5 (runes) + TypeScript + Vite 6. Package manager: `bun`.

### Frontend Layers (`src/lib/`)

- **`domain/`** — Pure functions and types with no framework deps (file types, fuzzy scoring, keyboard handling, syntax highlighting). This is the place for business logic.
- **`state/`** — Reactive stores using Svelte 5 runes (`$state`, `$derived`). Key stores: `explorer.svelte.ts` (per-pane state), `settings.svelte.ts`, `commands.svelte.ts` (command palette), `window-tabs.svelte.ts` (tab management).
- **`api/`** — Bridge to Rust backend via Tauri `invoke()`. `files.ts` wraps all IPC calls. `mock-invoke.ts` provides fake data when running outside Tauri (used by E2E tests in browser).
- **`composables/`** — Reusable behavior modules (drag-and-drop, column resize, marquee selection).
- **`components/`** — Svelte components. See `docs/architecture/components.md` for the full table.
- **`themes/`** — CSS theme files.

### Backend (`src-tauri/src/`)

All Tauri commands must be `async fn` (sync commands block the main thread). Key modules: `files/` (directory listing, CRUD), `search.rs` (fuzzy search with nucleo), `content_search.rs` (ripgrep-based grep), `thumbnails.rs` (image thumbnail cache), `archive.rs` (zip), `config.rs` (JSON persistence), `task_registry.rs` (cancellable background tasks).

### Entry Point

`src/routes/+page.svelte` — SPA root. Handles global keyboard shortcuts, initializes stores, and composes the layout: TitleBar > SharedToolbar > Sidebar + PaneContainer > StatusBar, plus overlay dialogs.

### Multiple Views

The explorer has three view modes: **Details** (virtual-scrolled table), **List** (CSS grid), **Tiles** (CSS auto-fill grid). `FileList.svelte` dispatches to the correct view component. When adding UI features that affect file display, ensure all three views are updated.

### IPC Pattern

Frontend calls `invoke("command_name", { args })` via `src/lib/api/files.ts`. When not running in Tauri (E2E tests), `mock-invoke.ts` intercepts calls and returns fake data. The detection uses `__TAURI_INTERNALS__` in `window`.

### Testing

- **Unit tests** (`tests/`): Vitest, Node environment, with `tests/setup.ts` providing minimal browser stubs (localStorage). Test domain logic and state behavior.
- **E2E tests** (`e2e/`): Playwright against Chromium on `localhost:1420`. Uses `bun run dev` as web server (not full Tauri). Mock invoke provides fake filesystem data.
- **Tauri-binary E2E** (`e2e-tauri/`): WebdriverIO + `tauri-driver` against the actually built Tauri binary. Linux + Windows only (see `e2e-tauri/README.md`); macOS needs ad-hoc coverage via unit tests until a WKWebView driver lands. Runs in CI via `.github/workflows/e2e-tauri.yml` on `ubuntu-latest` + `windows-latest`.
- `ALL_VIEW_MODES=1` env var runs E2E tests across Details, List, and Tiles views.

## Documentation

- **Start at [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — architecture diagram and pointers to deep references.
- Deep references in `docs/architecture/`: [backend](docs/architecture/backend.md), [frontend](docs/architecture/frontend.md), [components](docs/architecture/components.md), [features](docs/architecture/features.md), [cross-cutting](docs/architecture/cross-cutting.md).
- Lessons learnt: [docs/lessons_learnt.md](docs/lessons_learnt.md) — gotchas from closed issues.

### Code maps

- For cross-layer searches and bug hunts, read [docs/code-map/map-feature.md](docs/code-map/map-feature.md) first.
- For task-shaped changes (add a palette command / context-menu action / Tauri command / persisted setting), use the recipes in [docs/code-map/map-playbook.md](docs/code-map/map-playbook.md).
- Do **not** use `docs/ARCHITECTURE.md` or `docs/architecture/` to locate change sites — measured net-negative for this purpose.
- When adding features, update the relevant map and run `python3 docs/code-map/validate.py`.

## Issue Tracking (GitHub Issues)

Key commands:
- `gh issue create --title "Title" --body "Description"` — create issue
- `gh issue list` — list open issues
- `gh issue list --state all` — list all issues
- `gh issue view <number>` — view issue details (`--json` for machine-readable)
- `gh issue edit <number> --body "new body"` — update description
- `gh issue comment <number> --body "notes"` — add notes
- `gh issue close <number> --comment "why"` — close issue (automated by merge hook)
- `gh extension install jwilger/gh-issue-ext` — install if missing
- `gh issue-ext blocking add <blocked> <blocker>` — mark issue as blocked by another
- `gh issue-ext blocking list <number>` — list blocking relationships
- `gh issue-ext sub add <parent> <child>` — add sub-issue
- `gh issue-ext show <number>` — show all relationships

Convention: branch names map to issues by title. Branch `feat/my-feature` matches an issue whose title contains "my-feature". A hook validates that a matching open issue exists before allowing branch creation.

### Screenshot Requirements

When creating issues, include a `## Screenshots` section in the issue body with markdown checkboxes (e.g., `- [ ] sidebar`). Screenshots must be saved to `screenshots/<branch>/`. The merge hook verifies they exist. Use 'None required' only for pure backend/refactor changes with no user-visible effect. Behavioral fixes still need a screenshot showing the corrected behavior.

## Subagent Worktrees

Agent-tool worktrees are created from the repo's **default branch (main)**, not `dev`. Any delegated agent that writes code MUST start with `git merge origin/dev --no-ff -m "merge dev"` (or branch from `origin/dev` directly) before working, and the coordinator must verify `git merge-base <agent-branch> dev` is recent before merging. Agents must not run `bun run dev`/Playwright servers on port 1420 (worktree-served apps don't boot; the port belongs to the main session).

## Branching & Workflow

- All development happens on the `dev` branch. Create feature branches off `dev` and merge back to `dev`. Don't modify files directly on `dev`.
- Branch names must match the Beads issue name, prefixed with `feat/`, `fix/`, `refactor/`, etc. (a hook validates this).
- At session start, convert tasks in [@new_todo.md](@new_todo.md) into GitHub issues.
- Create implementation plans before converting into issues.

### Per-Issue Checklist

1. Create a GitHub issue (with `## Screenshots` section in the body)
2. Create a branch (hook validates a matching open issue exists)
3. Implement, then run `bun run test` and fix failures
4. Take required screenshots with `agent-browser` CLI; verify they capture working functionality
5. Create E2E Playwright tests if needed
6. Update docs: `ARCHITECTURE.md` for features, `lessons_learnt.md` for bugfixes
7. Merge to `dev` with a descriptive merge commit (hooks run E2E tests; fix any regressions)
8. Before stopping a session, run `ALL_VIEW_MODES=1 npx playwright test`

## Important Operational Principles

### E2E tests must assert on actual feature behavior
Don't just check that a component renders -- assert on the outcome. E.g., a QuickOpen test must verify that results appear for a query, not just that the modal opened.

### Debugging
When a bug resists quick diagnosis:
- Search the knowledge base and commit history for similar issues
- Add logging before adding more fix attempts
- Use the `research-scout` subagent for unfamiliar APIs/patterns
- Use the `architecture-reviewer` subagent periodically for design review
