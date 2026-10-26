# 1236: open palette with `Git:` misses Git targets that load after it opened

**Symptom.** Open the commit graph, open the palette before `git_log`
resolves and type `Git:`: only the seven static Git actions are listed, even
after the graph shows its branches and commits. Editing the query reveals
Checkout/Merge Branch and the commit/stash targets. Seen as a timing-dependent
failure of `e2e/git-command-palette.spec.ts` (Checkout Branch feature absent).

**Root cause.** Same as #1270: the command registry was a plain `Map`, so
`CommandPalette`'s `$derived` result list only re-ran when `query` changed.
`GitGraphView` re-registers its targets through `registerGitPaletteTargets`
once history lands, but nothing invalidated the open list. #1271 (reactive
registry revision) already fixed this for every registry source, Git targets
included; this issue was filed against a build that predates it. Reproduced by
running the new regression with `commands.svelte.ts` pointed back at
`createOwnedRegistry`: it fails at the same Checkout Branch assertion.

**Follow-on defect fixed here.** Once the list is live, the palette's
row-*index* highlight drifted: with `Git Graph: Refresh` highlighted, the late
branch rows were inserted above it and the highlight landed on
`Git: Checkout Branch experiment`, so Enter would have run a checkout the user
never chose. The highlight is now a command id (`domain/palette-selection.ts`);
`null` follows the top result (after open or typing), and a highlighted
command that disappears falls back to the top result.

**Gotchas.**
- Do not "fix" the spec by waiting for graph rows before opening the palette:
  that hides the stale-open-palette behavior instead of testing it.
- Any live result list with keyboard selection needs identity-based selection;
  an index is only stable while the list is a pure function of the query.
- All dynamic palette sources (Git targets, plugin contributions, `when`
  predicates over rune state) go through the same reactive registry; do not add
  a private snapshot of commands in a component.

**Guards.** `e2e/git-palette-live-targets.spec.ts` (mock `git_log` latency
1200ms, unchanged `Git:` query: targets appear, highlight stays on the chosen
static command, the late checkout target executes). `tests/domain/palette-selection.test.ts`
covers the selection contract. Registry reactivity stays covered by
`tests/state/reactive-registry.test.ts` (#1270).
