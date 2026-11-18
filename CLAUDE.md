# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

| Task                                  | Command                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev server (frontend only)            | `bun run dev`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Dev server (full Tauri app)           | `bun run start`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Clean rebuild                         | `bun run clean` (full) or `bun run clean:fast` (skip Rust)                                                                                                                                                                                                                                                                                                                                                                       |
| Type check                            | `bun run check`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Unit tests                            | `bun run test`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Single unit test file                 | `bunx vitest run tests/path/to/file.test.ts`                                                                                                                                                                                                                                                                                                                                                                                     |
| E2E tests (default view)              | `bun run test:e2e`                                                                                                                                                                                                                                                                                                                                                                                                               |
| E2E tests (all view modes)            | `ALL_VIEW_MODES=1 npx playwright test`                                                                                                                                                                                                                                                                                                                                                                                           |
| E2E tests (WebKit ≈ WKWebView proxy)  | `WEBKIT=1 npx playwright test --project=webkit` (on Arch: prepend `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true`; Ubuntu-only libs live in the webkit bundle's `sys/lib`)                                                                                                                                                                                                                                                     |
| Single E2E test                       | `npx playwright test e2e/specific.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                       |
| Tauri-binary E2E (Linux/Windows only) | `bun run test:e2e:tauri` (needs `cargo install tauri-driver`, `webkit2gtk-driver` on Linux, and a binary built via `VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle --features e2e-hooks` — the Tauri CLI, not `cargo build` (which serves `devUrl` and silently needs a dev server on :1420), and both hook gates (frontend flag + Rust feature; `src/lib/api/e2e-hooks.ts`), without which every spec fails at "dev e2e hooks never became ready"; see `docs/lessons/457-windows-tauri-smoke-hang.md`) |
| Native-suite TypeScript check          | `bun run check:e2e:tauri`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Extended native soak (opt-in)         | From a clean worktree run `bun run build:native:qualification`, then `SOAK_DURATION_MS=14400000 SOAK_SEED=<repro-seed> SOAK_EXPECTED_DISPLAY_SCALE=<native-scale> bun run test:e2e:tauri:soak` (`SOAK_MAX_CYCLES=1` gives a bounded real-native check; the runner verifies the generated build manifest, and reports/screenshots land in `qualification-results/`)                                                               |
| Performance tests                     | `bun run test:perf`                                                                                                                                                                                                                                                                                                                                                                                                              |
| High-load stress tests                | `bun run test:load` (own Playwright config on :1430; many git-graph tabs, leak churn, CPU throttle, 256MB heap cap; `LOAD_CYCLES=N` scales churn)                                                                                                                                                                                                                                                                                |
| Interaction perf sweep                | `bun run perf:sweep` (own config on :1440, `PORT` overrides; `PERF_SWEEP_OUT=f.json` writes medians). Copy `e2e-sweep/` + `playwright.sweep.config.ts` into an old release checkout to A/B; compare `taskMs` from concurrent runs (#1174) |
| Rust criterion benches                | `bun run bench:rust` (baselines recorded in `src-tauri/benches/*.rs` header comments)                                                                                                                                                                                                                                                                                                                                            |
| Bundle-size budget check              | `bun run check:bundle` (builds frontend, fails if main chunk gzip exceeds budget in `scripts/check-bundle-size.mjs` or the release build contains E2E hook code)                                                                                                                                                                                                                                                                                                             |
| Rust build only                       | `cd src-tauri && cargo build`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Runnable release binary               | `bun run build && cd src-tauri && cargo build --release --features tauri/custom-protocol` — a bare `cargo build --release` yields a DEV-mode binary that dials localhost:1420 (Tauri gates prod on the `custom-protocol` feature, which only the Tauri CLI passes)                                                                                                                                                               |
| Rust tests only                       | `cd src-tauri && cargo test`                                                                                                                                                                                                                                                                                                                                                                                                     |

When changing Rust code gated by `cfg(windows)`, also run
`cd src-tauri && cargo xwin check --target x86_64-pc-windows-msvc --lib --tests`
to type-check the Windows-only code from a Linux host. This requires
`cargo-xwin` to be installed on the host; without it, Cargo reports `no such
subcommand`. Windows CI remains the authority for Windows builds.

### Disk usage

- Before heavy builds and periodically during long sessions, check `df -h` and use `du -sh` on Rust target directories, worktrees and scratch output. Reclaim obsolete generated output before disk space becomes tight.
- Clean up your temporary binaries, logs and completed worktrees. Coordinate shared-cache cleanup with other agents; preserve active builds, uncommitted source and required evidence.

### WSL ↔ Windows: always `git push` after committing

When developing in WSL (e.g. on the `windows` branch), the Windows side builds/tests by pulling from the remote — it does **not** see your WSL working tree. A commit that isn't pushed never reaches the Windows build, so the fix appears to "not work" when it simply never arrived.

## Architecture Overview

**Stack:** Tauri v2 (Rust backend) + Svelte 5 (runes) + TypeScript + Vite 6. Package manager: `bun`.

Frontend layers (`src/lib/`): `domain/` (pure logic, no framework deps — put business logic here), `state/` (rune stores), `api/` (IPC wrappers; `mock-invoke.ts` fakes the backend outside Tauri, detected via `__TAURI_INTERNALS__`), `composables/`, `components/`, `themes/`. Backend (`src-tauri/src/`): all Tauri commands must be `async fn` (sync blocks the main thread). Entry point `src/routes/+page.svelte` composes the layout and owns global shortcuts.

Rules that bite everywhere:

- Three view modes (Details/List/Tiles) dispatched by `FileList.svelte` — display features must land in all three.
- Refresh policy is split deliberately: WHEN=`refresh-manager`, WHETHER=`pane-watch`, HOW=`pane-refresh`. Don't add a fourth gate, and don't build private refresh stacks inside components — the git graph did, and it produced #431/#432.
- Keep state machines and caches out of component-local scope (`<script module>` in a `.svelte` file is not a state layer). If it can't be unit-tested through an import, it will eventually be wrong unobserved (#444).
- Investigation-only scaffolding carries `Retire-when: #NNN closed`; when closing an issue, grep for its tag and delete or promote what it marks (CONTRIBUTING.md).
- Startup bundle accounting is sensitive even to internal refactors: #1346's List peek admission consolidation pushed gzip to 281,985 bytes against the 281,984-byte cap. Reproduce with `bun run check:bundle` on the locked dependencies; unit tests alone cannot verify this contract. #1357 reverts that refactor rather than increasing the budget.

### Path-scoped rules

Feature rules live in `CLAUDE.md` files next to the code they govern; Claude Code loads one when a session reads files under its directory. Many modules sit in flat directories, so each layer file also points to the rules for its modules that live elsewhere (mapping: `docs/claude-md-rehaul-mapping.md`).

| File | Covers |
| --- | --- |
| `src/lib/components/CLAUDE.md` | File-list views, Details, overlays/zoom, marquee, previews, dialogs/toasts, context menu, bookmark drop surfaces, Git badges |
| `src/lib/components/git-graph/CLAUDE.md` | Git graph frontend, its Rust commands, PR mutations, avatars |
| `src/lib/state/CLAUDE.md` | Watcher callbacks, Miller columns, trash location, window title/launch focus, preview content, Quick Open session |
| `src/lib/domain/CLAUDE.md` | Terminal key ownership, List peek stages, bookmark feedback, Markdown frontmatter, launch parameters |
| `src/lib/themes/CLAUDE.md` | Git badge theme variables |
| `src-tauri/CLAUDE.md` | Rust test layout and portability, config watch, PTY and discard tests, index of flat-module rules |
| `src-tauri/src/files/CLAUDE.md` | Quick Open search cache and recursive watches, trash/Recycle Bin, Linux volumes |
| `src-tauri/src/renderer_owner/CLAUDE.md` | Web-process loss recovery |
| `src-tauri/src/clipboard/CLAUDE.md` | File clipboard worker, clipboard routing |
| `src-tauri/src/native_file_drag/CLAUDE.md` | GNOME Wayland drag intent |
| `src-tauri/src/wallpaper/CLAUDE.md` | Wallpaper platform checks |
| `e2e/CLAUDE.md` | Browser Playwright test rules |
| `e2e-tauri/CLAUDE.md` | Native qualification, WebDriver diagnostics, native probes |
| `tests/CLAUDE.md` | Vitest suite configuration and teardown |
| `website/api/CLAUDE.md` | User-report relay |
| `.github/workflows/CLAUDE.md` | CI triggers, caches, release gate, native E2E target cache |
| `packaging/CLAUDE.md` | Linux portal packaging |
| `docs/CLAUDE.md` | Architecture-pressure passes |

## Documentation

- **Start at [docs/code-map/](docs/code-map/)**: [map-feature.md](docs/code-map/map-feature.md) for cross-layer work and bug hunts, [map-playbook.md](docs/code-map/map-playbook.md) recipes for task-shaped changes (new palette command / context-menu action / Tauri command / setting), [map-folder.md](docs/code-map/map-folder.md) as the exhaustive per-file index. For a small localized change you can already name, skip the maps and grep (measured net loss on cheap tasks; prose architecture docs were deleted for the same reason — see [STUDY.md](docs/code-map/STUDY.md)).
- **Keep the maps current or they turn harmful.** New/moved source file → update `map-folder.md` (+ the `map-feature.md` cluster), then `python3 docs/code-map/validate.py --coverage`. CI runs the same check.
- [docs/lessons/](docs/lessons/) — gotchas from closed issues, **one file per issue**: write `docs/lessons/<issue>-<slug>.md` when you fix a bug (never append to the frozen [docs/lessons_learnt.md](docs/lessons_learnt.md) archive — shared-file appends conflicted every open PR, #544). When hunting a bug, search both: `grep -ri <term> docs/lessons/ docs/lessons_learnt.md`.
- Architecture passes over [docs/architecture-pressure.md](docs/architecture-pressure.md) follow [docs/CLAUDE.md](docs/CLAUDE.md).

## Issues, Branches, Screenshots

- All development happens off `dev`; feature branches merge back to `dev` with a descriptive squash commit. Don't modify files directly on `dev`. At session start, convert tasks in [@new_todo.md](@new_todo.md) into GitHub issues (plan first; the plan can live in the issue body).
- Branch ↔ issue convention: branch `feat/my-feature` must match an **open GitHub issue** whose title contains `my-feature`; a hook validates this at branch creation. Prefixes: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`.
- Relationship tooling (blocking, sub-issues) is the `jwilger/gh-issue-ext` extension (`gh issue-ext …`).
- Issue bodies need a `## Screenshots` section with checkboxes; files go in `screenshots/<branch>/` and the merge hook verifies they exist. "None required" is only for changes with no user-visible effect; behavioral fixes still need one showing the corrected behavior. Verify a screenshot actually demonstrates the feature before counting it.
- Keep `evidence/` available for committed image-only PR acceptance proof: the automated review gate renders those files directly from the PR. It is distinct from issue screenshots, so do not add a blanket `evidence/` ignore rule.
- Browser specs write PNGs into `screenshots/` and `evidence/` only under `CAPTURE_EVIDENCE=1` (`e2e/evidence-shots.ts`, #1123); ordinary and CI runs skip them, so run the spec with that flag when producing issue or PR evidence.
- The merge hook does **not** close issues — close them yourself (`gh issue close N --comment`) when the work lands on dev.
- Before ending a session that merged UI work: `ALL_VIEW_MODES=1 npx playwright test`.
- Make sure to clean up the worktree after merging.

## Releases

- **Versioning:** a minor release (0.x.0) only for relatively large features; a patch release (0.x.y) for everything else. The renumbering from the 1.x line to the 0.x alpha line is tracked in #1783.
- **Prepare** on a `chore/release-vX.Y.Z` branch, in a PR to `dev` that bumps the version and the changelog and nothing else (CONTRIBUTING.md): `package.json`, `src-tauri/Cargo.toml`, the app's own entry in `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json` and `PKGBUILD`, plus a `CHANGELOG.md` entry.
- **Publish** once dev-push CI is green for that tree: open a `dev` → `main` PR ("Release vX.Y.Z") and merge it when its `release-gate` check passes. The push to `main` runs `release.yml`, which builds, tags and publishes only when `package.json`'s version is not yet tagged, and refuses any tree without green dev-push CI. Gate details: [.github/workflows/CLAUDE.md](.github/workflows/CLAUDE.md).

## Verification

CI selection (#1367, details in `.github/workflows/CLAUDE.md`): PR Chromium runs
every spec for any `src/` change; PR WebKit narrows unless a WKWebView-sensitive
path changes (CSS/themes, zoom/overlays, FileList/FileItem, marquee, preview,
DnD, peek, component styling); `ALL_VIEW_MODES` Chromium runs on dev pushes,
nightly, and for PRs touching view-mode components, stylesheets, themes or
global markup. Mock backend, e2e helpers,
fixtures, configs and lockfiles still select everything. Version-only bumps run
no browser or Rust tests. PRs into main run only the `release-gate` check:
release.yml requires green dev-push CI for the same tree, so merge to main only
after dev CI passes and `release-gate` is green.

The three test tiers see different things; pick by what could actually break:

1. **Vitest (`tests/`)** — domain logic and store behavior. The default home for every fix's regression test.
2. **Browser Playwright (`e2e/`)** — UI behavior against `mock-invoke.ts` on :1420. Good for interaction/focus/layout. **Structurally blind to backend timing** (watchers, git, IPC latency), and **circular for new backend features**: if you wrote the mock, the test proves the UI agrees with your own assumption, not with the backend.
3. **Tauri-binary E2E (`e2e-tauri/`)** — WebdriverIO + tauri-driver against the real binary: real Rust, real fs watchers, real git (see `e2e-tauri/README.md`; keep this suite small and reserve it for what genuinely needs the real backend).

Anything whose failure mode involves races, watcher timing, git state, or cache staleness needs tier 3 or a Rust temp-repo test in `src-tauri` — a green mock E2E is not evidence for those.

**Repro-first for bug fixes.** Before changing logic, write the test that fails for the reported reason (or demonstrate the failure at the pre-fix commit). Gold standard: the test passes on your branch and fails with the fix reverted. If the buggy logic has no importable seam, extracting the seam is part of the fix — don't settle for verifying a transcribed copy.

**Adversarial verification for high-risk changes.** Concurrency, caching, perf claims, and anything self-graded by its implementer gets a separate verifier (a subagent with no stake in the claims) that tries to _falsify_ each claim — staleness attacks on caches, interleaving attacks on async flows, measured numbers for perf claims — and reports CONFIRMED / PLAUSIBLE / REFUTED per claim. This found real bugs both times it was run; budget for it on any structural change.

**E2E tests assert outcomes**, not existence — a QuickOpen test verifies results appear for a query, not that the modal opened.

## Debugging

When a bug resists quick diagnosis: search `docs/lessons/` + the frozen `lessons_learnt.md` archive and commit history first, then add targeted logging/instrumentation before another fix attempt. Suite-wide test timeouts (~5 s) under parallel/CPU load are a known flake mode — rerun the failing files in isolation before treating them as regressions.

## Delegation & Subagent Worktrees

- If the main model is Fable, tokens are very expensive, so whenever possible delegate work to Opus and Sonnet subagents. Use Fable only for high level synthesis and understanding. Do NOT use Fable subagents unless explicitly instructed to.
- Agent-tool worktrees are created from **main**, not `dev`: a delegated agent must start by branching from `origin/dev` (or the coordinator's integration branch), and the coordinator verifies `git merge-base` before merging.
- Agents work **only inside their worktree cwd with relative paths**. Absolute paths leak edits into the main checkout — it has happened; coordinators should spot-check `git -C <main-repo> status` while agents run.
- Port :1420 belongs to the main session. Agents needing a dev server or E2E run use their own port with a throwaway config.
- Squash-merge conflicts in `map-feature.md` are usually both-append — resolve as a union, checking for line-level supersedes. (`lessons_learnt.md` is frozen; lessons are per-issue files now, which cannot conflict.)
