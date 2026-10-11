# Cross-pane selection handover (TraceExplorer #31)

Worktree: `/var/tmp/te-wt2/x31`, branch `feat/cross-pane-selection`.
HEAD merge-base equals the local `origin/dev` tip:
`0c7bd95fc14172a03b264f494df7734f48ae7bfe`.
No commits, pushes, GitHub mutations, or edits to other checkouts were made.

## Implementation

- `src/lib/domain/workspace-selection.ts`: primary Ctrl/Meta click in another
  pane preserves focus; Shift keeps range/focus behavior. Combination preserves
  each pane's existing selection order, focused pane first, then layout visual
  order, deduplicated by exact path.
- `src/lib/state/pane-pointer-focus.ts` and `ExplorerPane.svelte`: capture the
  pointer gesture's prior DOM focus owner, restore it during focusin capture,
  and end ownership on pointerdown, mouseup, keyboard input, blur, pointercancel
  or native drag start. Mousedown default remains enabled for HTML5 drag.
- `FileList.svelte`: applies the same pure rule to explicit click focus across
  Details/List/Tiles. Typeahead is gated by active explorer ownership.
- `window-tabs.svelte.ts::getCombinedSelection`: reads only the active explorer
  tab's layout leaves through the readiness-aware `getExplorer` accessor.
- Optional `PluginWorkspace.getCombinedSelection` and runtime capability
  `combinedSelection`; existing `getSelection` remains active-pane-only.
- Plain clicks replace only the target pane's selection and preserve the other
  panes, matching existing pane-local selections used in split-pane operations.
- Existing selected colors and inactive-pane styling are retained.

## Verification results

API keys were unset for verification commands. Full command output is retained
under `/tmp/x31-*.log`.

| Command | Actual result lines |
| --- | --- |
| Initial `bunx vitest run tests/domain/workspace-selection.test.ts` with old unconditional focus policy | `Test Files 1 failed (1)`; `Tests 12 failed \| 56 passed (68)` (expected repro) |
| Intermediate targeted domain/state/SDK run | `Test Files 3 passed (3)`; `Tests 71 passed (71)` |
| Final targeted domain/state/pointer/SDK run, `--maxWorkers=2` | `Test Files 4 passed (4)`; `Tests 74 passed (74)` |
| Initial `bun run check` | `COMPLETED 1806 FILES 4 ERRORS 0 WARNINGS 2 FILES_WITH_PROBLEMS`; three new test type errors corrected, one existing missing `@vercel/blob` |
| Subsequent `bun run check` | `COMPLETED 1808 FILES 1 ERRORS 0 WARNINGS 1 FILES_WITH_PROBLEMS`; only existing missing `@vercel/blob` |
| `bun run test` | `Test Files 13 failed \| 376 passed (389)`; `Tests 19 failed \| 3676 passed \| 3 skipped (3698)`; `Errors 4 errors` |
| `bunx vitest run --maxWorkers=2 --exclude tests/native-driver-ports.test.ts --exclude tests/website/report-relay.test.ts --exclude tests/native-suite-typecheck.test.ts` | `Test Files 1 failed \| 386 passed (387)`; `Tests 1 failed \| 3691 passed \| 3 skipped (3695)` |
| Isolated `bunx vitest run tests/domain/git-graph-branch-line.test.ts --maxWorkers=1` | `Test Files 1 passed (1)`; `Tests 28 passed (28)` |
| First separate perf run | `Test Files 2 failed \| 1 passed (3)`; `Tests 2 failed \| 27 passed (29)` |
| Second separate perf run | `Test Files 2 failed \| 1 passed (3)`; `Tests 3 failed \| 26 passed (29)` |
| Perf run after native build completed, `bunx vitest run -c vitest.perf.config.ts --maxWorkers=1` | `Test Files 3 passed (3)`; `Tests 29 passed (29)` |
| `CARGO_TARGET_DIR=/var/tmp/te-wt2/target-x31 cargo test --offline --manifest-path src-tauri/Cargo.toml --lib prepared_selection` | `test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 2148 filtered out; finished in 0.00s` |
| `bunx playwright test --config playwright.cross-pane.config.ts --list` | `Total: 21 tests in 1 file` |
| `python3 docs/code-map/validate.py --coverage` | All three maps: `0 unresolvable`; `coverage: 725/725 source files in map-folder.md` (tracked files; both new source files are mapped) |
| `git diff --check` | No output, exit 0 |

Full-suite failures separate into missing `@vercel/blob`, the allowed native
suite typecheck timeout, socket-denied native-driver port tests (`listen EPERM:
operation not permitted 127.0.0.1`), and worker-load timeouts. The bounded rerun
cleared those non-socket behavior failures except one Git-graph timing-budget
assertion, which passed alone. Perf timing failures during the Rust build also
cleared after that build finished.

The initial Cargo attempt failed with `Read-only file system (os error 30)` at
its user-specified target directory. Automatic escalation permitted writing
that build directory; the offline test then passed. Existing vendor Wry emitted
8 deprecation warnings. No Rust source was changed or formatted.

Independent review confirmed the pure rules, API ordering/scope and final
focus arbitration by source inspection. It identified the earlier cancelled
mousedown drag risk, which was corrected. An attempted inline Chromium launch
was rejected by the sandbox before execution (`Operation not permitted (1)`);
no browser or server ran. Feature Playwright execution and screenshots remain
unverified.

## Lead follow-up

1. Run `bunx playwright test --config playwright.cross-pane.config.ts`. It starts
   the host on port **14331**, never 1420. All three views are explicitly covered
   by the spec, including toggling, plain/Shift/right clicks, keyboard isolation,
   visible selected fills, public plugin API ordering/dedup and Ctrl-drag copy.
2. Obtain corrected-behavior screenshot evidence before committing/merging.
3. Update TraceExplorer's read-only external
   `integration/plugin-sdk/index.d.ts` with
   `getCombinedSelection?(): FileEntry[]`, and update its
   `e2e/harness/view-fixture.ts` when that plugin worktree is available.
4. Custom Trace/plugin button views retain their existing focus semantics via
   `FileViewPane.select`; this implementation covers built-in file listings.
   Combined selection still includes selections held by plugin-backed panes.
5. Check host issue #1021 using the lead's authenticated GitHub access. The web
   lookup returned a cache miss, local history has no #1021 match, and this tip
   contains no existing combined-selection helper. Existing layout and per-pane
   selection helpers were reused.
6. The supplied TraceExplorer `openai-image/workspace-selection.ts` adapter is
   absent at the specified read-only path. Its existing input-picks header was
   read; no plugin checkout was changed.

The final typecheck after adding the isolated Playwright config is recorded in
`/tmp/x31-final-check.log`.
