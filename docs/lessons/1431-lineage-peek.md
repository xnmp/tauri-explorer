# Lineage peek: occurrences, mocks and perf baselines

Lineage peek (#1431) lists a merge output once under each parent, so a path can
repeat in `displayEntries`.

- **Index by occurrence, not `indexOf`.** `displayEntries.indexOf(entry)` and
  `findIndex(e => e.path === path)` return the first occurrence. The cursor,
  Shift anchor, keyboard walk and focus now go through `explorer.cursorIndex`
  and an occurrence key (`folder-peek-flat.ts`); a key that names another path
  is ignored, so code that only sets `cursorPath` stays correct.
- **Dedupe file-shaped outputs.** Anything that turns the visible entries into
  a file list (selected entries, the status bar, `getVisibleEntries` for
  plugins) must keep each path once, or a delete or move receives it twice.
- **A group row has no placement of its own.** Pruning walks up an occurrence
  key by its prefix (`key.slice(0, lastIndexOf("\0"))`), because a group row is
  in `tree.headers`, not `tree.meta`.
- **Explorer mocks are partial.** `window-tabs` and command tests mock the
  explorer with a handful of fields; new getters read from them
  (`lineageHidden`, `lineageOptions`) need `?? []` / `?.` at the call site.
- **Perf baselines must not share a dev server with your edits.** A perf sweep
  running from the working tree measured HMR reloads triggered by edits made
  meanwhile. Run the baseline and the candidate from `git archive` copies
  (each with its own `bun install`) on separate ports.
