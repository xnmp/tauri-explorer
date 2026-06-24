Continuing work on the structural refactor phase of tauri-explorer: Modal primitive with focus trap, explorer god-store decomposition, ContentSearchDialog decomposition, active-pane access unification, scm/git-status store unification, z-index scale.

**Previous session summary:** Ran a full-codebase multi-agent review (~150 verified findings: `docs/reviews/comprehensive-review-2026-06-11.md`), then fixed everything except deferred Windows issues (`docs/reviews/windows-deferred-issues.md`) and the six structural refactors below. All fixes are committed in 12 logical chunks on branch `working` (hygiene → build → CI → 4× backend → domain+api → state → views → dialogs → tests → docs).

**Key context:**
- User preference (saved to memory): **no parallel subagent fleets — do the work directly in the main loop**; they burned token limits and caused cross-agent conflicts.
- All gates green at handover: `bun run check` 0 errors · vitest 489/489 · cargo 86/86 · clippy 0 warnings · fmt clean · Playwright 227/227 · `ALL_VIEW_MODES=1` 370 passed.
- Work happens on branch `working` (not `dev`). Commit style: conventional prefix, lowercase, body explains why, ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- One open manual check: the new CSP in `src-tauri/tauri.conf.json` needs a `bun run start` run in the real webview (PDF preview via iframe + thumbnails are the risk areas — browser e2e can't validate CSP).

**Current state:** Tree clean, everything committed and verified. No in-progress work. The six refactors below are scoped but not started.

**Next steps (the six refactors, in suggested order):**

1. **Modal primitive + focus trap + z-index scale** (do these together — Modal owns layering).
   Eleven hand-rolled overlay implementations, none with a focus trap (Tab walks out of every modal despite `aria-modal="true"`): QuickOpen, ContentSearchDialog, CommandPalette, SettingsDialog, BulkRenameDialog, WorkspaceDialog, JobsPanel, DeleteDialog, RenameDialog, NewFolderDialog, plus ScmSidebarView's confirm overlay. RenameDialog/NewFolderDialog/DeleteDialog share ~200 lines of near-identical styles — convert those three first to prove the primitive, then sweep the rest. Build one `Modal.svelte` (backdrop, Escape, focus containment, ARIA, animation) + a CSS z-index scale as custom properties (current hardcoded values collide: ProgressDialog at 900 renders *under* dialogs at 1000; values seen: 100/900/999/1000/1001).
   ⚠ Preserve existing CSS class names (`.dialog-overlay`, `.settings-dialog`, `.overlay`, `.dialog`, `.quick-open-dialog`, …) — dozens of e2e selectors depend on them.

2. **`src/lib/state/explorer.svelte.ts` decomposition** (~800 lines, imports 15 sibling stores, ~40 public methods).
   Keep per-pane core state (path/history/entries/selection/sort/view) in place. Extract: `pane-watch.ts` (watchDirectory/updateWatch/destroyWatch + refresh lifecycle), `pane-mutations.ts` (rename/create/delete plumbing), and move the non-pane command actions (`setAsWallpaper`, `openInTerminal`, `createSymlinkForEntry`) into the command layer (`state/commands/`). These are already near-free functions closed over `coreState` — promote them to modules taking the instance/state as a parameter, no behavior change.
   ⚠ Recently added logic that must survive intact: the per-pane navigation generation guard in `navigateInternal`, refresh()'s streamed-chunk accumulation + path-change bail, and `destroy()` calling `dirListing.cleanup()`.

3. **ContentSearchDialog decomposition** (~950 lines).
   Extract a `useContentSearch` composable owning the IPC stream lifecycle (activeSearchId, unlisten, generation counter, seenPaths, the register-listener-BEFORE-invoke pattern with its browser-mode try/catch); reuse `VirtualList.svelte` instead of the hand-rolled ITEM_HEIGHT/scrollTop/page math. Pure flatten logic already lives in `domain/content-search-flatten.ts` — keep it there.

4. **Active-pane access unification.**
   Two competing paths: Svelte context (`state/pane-context.ts`) vs `windowTabsManager.getActiveExplorer()` singleton, used inconsistently across ~11 components. Rule to apply: components rendered *inside* a pane resolve their explorer via context; only window-global surfaces (CommandPalette, QuickOpen, ContentSearchDialog, SCM panel) use the singleton.
   ⚠ `GitStatusBadge` consumes a `"pane-id"` context that `ExplorerPane` sets at init (with `untrack`) — this is a live cross-file contract; a previous agent deleted it as "unused" while another added the consumer. Audit consumers before touching context keys.

5. **scm/git-status store unification (frontend only).**
   `state/scm.svelte.ts` (SCM panel, `gitSummary`) and `state/git-status.svelte.ts` (badges, `get_git_status`, now keyed per directory) both subscribe to `git-status-changed` and fetch separately; `scm.refresh()` imperatively chains `gitStatusStore.refresh()`. Feed both from one repo-status source. The *backend* split (files/git_status.rs for badges vs git.rs for SCM) is documented as intentional — leave it.

---

## Architecture & Learnings

### Layout
- **Frontend:** `src/lib/domain/` (pure, no framework deps — heavily expanded this session: `titlebar.ts`, `autocomplete.ts`, `scm-tree.ts`), `state/` (Svelte 5 runes stores, ~40 files), `api/` (`files.ts` is the single `invoke()` boundary; `mock-invoke.ts` for browser/E2E), `composables/`, `components/`. Entry: `src/routes/+page.svelte`.
- **Backend:** `src-tauri/src/` — `files/` (CRUD/listing/watcher), `search.rs`, `content_search.rs`, `git.rs` + `files/git_status.rs` (intentionally split), `system.rs` (trash/window/log — extracted from lib.rs this session; lib.rs is now pure wiring), `thumbnails/archive/config/clipboard/wallpaper/nano_banana`. All commands async; blocking work in `spawn_blocking` (helper: `files::run_blocking`).

### Patterns established this session (don't regress)
- **Listener-before-invoke:** backend threads emit events immediately, so register the Tauri event listener (buffering until the id is known) *before* the invoke. Done in directory-listing, QuickOpen, ContentSearchDialog.
- **`listen()` rejects outside Tauri** (browser e2e) — every `listen` call site needs try/catch with a graceful fallback, or the feature breaks the whole app in browser mode.
- **Overwrites are transactional** (stage-to-temp + swap) and same-parent transfers are guarded in `performFileTransfer` (`file-transfer.ts`) AND the backend.
- **Svelte 5:** never `$effect` for state sync (`$derived` instead — user rule); `untrack()` for deliberate init-time captures; an effect reading state it (indirectly) writes self-defeats (see `use-progressive-render.svelte.ts` — decision logic extracted to a tested pure function because `$effect`s are no-ops in the Node test env).
- **Config persistence:** all config writes go through `writeConfigQueued` (persisted.ts) — per-file serialized latest-wins.

### Gotchas
- **A PreToolUse hook runs the full unit suite before any Bash command containing `git commit`** — and a hook failure blocks the *entire* command, including a preceding `git add &&`. Stage and commit; if the hook flakes, re-run (one noise-level perf threshold was already relaxed).
- **Svelte-check / clippy hooks run on every .svelte/.rs edit** and report file-scoped diagnostics.
- **Unit tests must not import chains that pull `.svelte` components** (vite CSS preprocessing flakes in the Node env) — e.g. `state/commands/view-commands.ts` → `sidebar-views.svelte.ts` → `FilesSidebarView.svelte`. The chord-shortcuts test deliberately avoids view-commands for this reason.
- **E2E:** never `waitForTimeout` before a snapshot read (`textContent()`/`count()`/`inputValue()`) — use auto-waiting assertions or `expect.poll`. Streaming result lists (QuickOpen) need polls, not first-item-visible. Double-click navigation after a reload is racy (row re-render between clicks → select-only) — navigate by URL (`/?path=...`) when navigation isn't the test subject.
- **Perf budgets** (`e2e/performance.spec.ts`) have `retries: 2` — wall-clock measurements flake under parallel workers; CI runs them in a dedicated workflow.
- Package manager is **bun** exclusively. `bun.lock` was regenerated against public npm (old one pinned an unreachable internal registry); CI uses `--frozen-lockfile`.

### Commands
| Task | Command |
|---|---|
| Type check | `bun run check` |
| Unit tests | `bunx vitest run` |
| Rust | `cd src-tauri && cargo test && cargo clippy --all-targets && cargo fmt --check` |
| E2E (fast) | `bunx playwright test` |
| E2E full gate (before ending session) | `ALL_VIEW_MODES=1 npx playwright test` |
| Single e2e spec | `npx playwright test e2e/<spec>.spec.ts` |

### Reference docs
- `docs/reviews/comprehensive-review-2026-06-11.md` — full findings; the Architecture section holds the original rationale for these refactors.
- `docs/reviews/windows-deferred-issues.md` — deferred Windows work (do not pick up unless asked).
- `docs/lessons_learnt.md` — tail section "2026-06-11 comprehensive review & fix campaign".
