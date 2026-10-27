# Lineage peek: show an image's edits with Folder Peek (design, 2026-10-28)

Status: design, not started. Host phases come first; the TraceExplorer plugin phase follows
and detects the new capability.

## 1. Goal

When **Show traces** is on, the built-in Details, List and Tiles views group each image's
edits under it, and the Folder Peek caret reveals them. The Trace view, the graph view
contributed by TraceExplorer, stays as the fourth view, unchanged.

The children are ordinary files in the same folder; they are already in the listing, just
flat. Lineage peek is therefore a **regrouping of entries the host already lists**, not
virtual entries. Every row is a real file, so selection, Preview, rename, delete and drag
keep working, apart from the duplicates described in §4.

The host part is generic: any plugin can supply "file X was made from files P, Q" for a
folder. TraceExplorer is the first provider.

## 2. Terms

- **Lineage parent:** a file this file was made from. The provider supplies these.
- **Parent set:** all of a file's lineage parents.
- **Root:** a file with no lineage parent in this folder. Roots and ordinary files make up
  depth 0.
- **Group row:** a row that is not a file. It collects the children that P shares with other
  parents, and is labelled "with B" or "with B, C".
- **Occurrence:** one appearance of a file in the tree. A merge output has one occurrence
  under each parent.

## 3. Grouping rule

For an entry P that has lineage children:
1. **Children made from P alone** are direct children of P.
2. **Children whose parent set S contains P and other parents** go in one group row per
   distinct S. The group row is labelled with S minus P, in parent-set order, as "with B" or
   "with B, C". A label longer than 3 names becomes "with B, C +2". The group row shows the
   first co-parent's thumbnail.
3. **Order:** group rows first, sorted by label, then direct children in the pane's sort.
   This follows folders-first. Each level sorts independently, as Folder Peek already does.
4. **Parents outside the folder** (subfolder or external) count in the parent set and appear
   in the label with an external marker. A file whose only parents are external is a root.
5. **A missing intermediate.** When a parent file is no longer in the folder (deleted or
   moved), the file is attached to its nearest present ancestors, as the provider
   supplies them (§6). With none present, it is a root.

**Worked example.** A was edited into c and d, and A + B were merged into m:

```
A
├─ with B        (group row)
│   └─ m
├─ c
└─ d
B
└─ with A
    └─ m          (same file, second occurrence)
```

Anything in a group can be peeked further, so m's own edits nest under m. The graph cannot
loop back on itself, and the host rejects a provider graph that does (§5). Copies multiply
only as far as the user opens them.

The host owns the grouping algorithm. The provider supplies only the parent relation. This
keeps the rule identical for every provider and puts it in one pure, tested function.

## 4. Host changes

### 4.1 Row identity separate from file path (phase H1, no behaviour change)
Folder Peek keys rows by path today:
- `PeekTree.meta: Map<path, PeekMeta>`;
- `displayEntries` as `FileEntry[]`;
- `cursorPath` and `selectionAnchorPath`;
- `prunePeekSelection`;
- `entryIndicesForRows`.

About 15 modules read `displayEntries`.

Change:
- Introduce `PeekRow { key, depth, parentKey, item: { kind: "entry", entry } | { kind: "group", group } }`.
  - `key` is the occurrence path: the chain of parent keys plus this entry's path or group id.
  - Directory peeks produce exactly today's rows, with `key` equal to the path.
- **Cursor, anchor, Shift ranges, keyboard walk and virtualization** use row keys.
- **Selection** stays a set of file paths. Selecting one occurrence highlights every
  occurrence, because it is the same file. File operations act on paths, so a duplicate is
  never acted on twice.
- **Group rows** are never in the selection. Ctrl or Shift ranges skip them. Clicking one
  moves the cursor and toggles it, like a caret-less folder click.

Ship H1 alone, with the full peek suite passing unchanged. It is the risky refactor.

### 4.2 Generic lineage grouping (phase H2, Details first)
- **SDK contribution**, behind a capability string `entryLineage`, mirrored in
  `integration/plugin-sdk/index.d.ts`:

  ```ts
  registerEntryLineage?(c: EntryLineageContribution): void;
  interface EntryLineageContribution {
    id: string;                      // `<pluginId>.<name>`
    title: string;                   // "Traces": the View menu and command label
    available(directory: string): boolean | "pending";
    load(directory: string, signal: AbortSignal): Promise<EntryLineage>;
    subscribe?(directory: string, changed: () => void): () => void;
  }
  interface EntryLineage {
    revision: string;
    /** path → its lineage parents, in input order. Paths are in this directory. */
    parents: ReadonlyMap<string, readonly LineageParent[]>;
  }
  type LineageParent =
    | { kind: "entry"; path: string }
    | { kind: "external"; label: string; thumbnailPath?: string };
  ```
- **Pane option "Show traces"** (the contribution's title):
  - It sits in the View section of the context menu and has a command.
  - It is per pane and remembered like the file-view preference.
  - It applies only to Details, List and Tiles. A plugin view such as Trace is unaffected.
  - It defaults to on in folders where `available` is true.
- **Projection.** A pure `lineageRows(listing, lineage, expanded, sort)` returns `PeekRow`s.
  It implements §3 and is composed with directory peeks, so a subfolder still peeks as a
  folder.
- **Validation.** The host drops edges to paths not in the listing and edges to the file
  itself. If the remaining graph has a cycle, grouping is off for that folder and a counter
  records it.
- **Peekability.** An entry is peekable if it is a directory or has lineage children.
  Generalise the `kind === "directory"` checks: `flattenPeekEntries`, the caret in the three
  views, `canPeekAt`, `resolvePeekCommandTarget`.
- **Expanded state.** The existing `Map<path, ordinal>` is kept.
  - A file's peek is keyed by its path, so opening m opens it at every occurrence. It is the
    same file.
  - A group row is keyed by `group:<P>|<sorted S>`.
  - `pruneExpanded` drops keys whose file or parent left the listing.
- **Drops and spring-load:**
  - Dropping onto a file's peek or a group row targets the current folder.
  - A drag never spring-opens a lineage peek, because spring-load is for moving into
    folders.
- **Name filter:**
  - Folder Peek filters depth 0 only, which would hide a matching edit inside a closed
    lineage.
  - While a name filter is active, grouping is suspended and matches show flat.
  - The filter is cleared to return to grouping.
- **Ctrl+A and typeahead.** These stay at depth 0, as Folder Peek decided
  (folder-peek.md §14: no file actions on invisible selections). A new command,
  **"Select with edits"**, extends the selection to every lineage descendant of the
  selected files. That covers "move this image and all its edits".
- **Status bar.** It counts real files, unchanged. Duplicates and group rows are not
  counted.
- **Refresh, with no intermediate frames:**
  - When the listing and the lineage arrive together on first paint, the host holds up to
    the existing 400 ms bound (the same rule as `fileViewEligibilityPending`).
  - A new file that the lineage does not yet know is held back for up to 300 ms, waiting for
    the provider's `changed` signal. After that it appears as a root. Otherwise a new edit
    output would flash at root and then jump under its parent.
  - A lineage revision change re-projects through the existing motion: rows move, never
    disappear and reappear.

### 4.3 List and Tiles (phase H3)
- **List:** an open root is a card, as today, with group rows and nested levels unboxed
  inside it. Lineage guides reuse `PeekGuides`.
- **Tiles:** Tiles panels open only for top-level entries today, but lineages go deep.
  - A root's panel shows its group sections (labelled, with the co-parent thumbnail), then
    its direct children.
  - A tile inside a panel that has children gets a caret. Opening it stacks a further panel
    under the parent's panel, using the existing "stacked under a row" placement, nested one
    panel per level.
  - This is the only new Tiles geometry. If it proves too costly, the fallback is to flatten
    descendants in the root's panel by generation, with the sections kept.
- **Preview of a group row:** it shows the parents the group combines, with thumbnails, and
  the number of files in the group. It uses the existing Preview pane, through a host-owned
  target.

## 5. Invariants (each with a test)
- Every file in the listing appears in the grouped tree, either at depth 0 or under at least
  one present parent. No file becomes unreachable.
- A file appears once under each of its present parents, inside the group for its exact
  parent set.
- Selection is a set of paths. Every occurrence of a selected path is highlighted, and file
  operations receive each path once.
- With grouping off, or with an unavailable provider, rows are byte-identical to today's
  Folder Peek rows.
- A cycle, a foreign path or a self-edge never throws. Grouping falls back to flat, and the
  fallback is counted.
- Collapsing never leaves a hidden selection, under the existing `prunePeekSelection` rule,
  applied per occurrence. A path stays selected while any occurrence is visible.

## 6. TraceExplorer side (phase P1)
- **Registration.** `registerEntryLineage` runs when the `entryLineage` capability exists;
  otherwise nothing changes. The id is `xnmp.trace-explorer.lineage` and the title is
  "Traces".
- **`available`** is the existing `traceFolderVisibility`.
- **`load`:**
  - It uses `trace_folder_members` (path to component and node key) and
    `trace_component_nodes` (node parents). Both already exist and are paged.
  - It maps node parents to member paths:
    - Parents with no file in the folder are resolved through their own parents to the
      nearest present ancestors (§3 rule 5).
    - Parents in a subfolder or outside the folder become
      `{ kind: "external", label, thumbnailPath }`, from the existing reference badges.
  - Running-output placeholders have no file and are not part of lineage peek. The Trace
    view still shows them.
- **`subscribe`** fires on the plugin's existing invalidation (`trace:changed` and
  `onFilesChanged`).
- **Commands.** Keep "Toggle Trace View" (Alt+M P). Add "Show traces", which toggles the
  host pane option.
- **Mock backend.** The e2e harness mirrors the lineage mapping from `folder_graph.rs`, per
  AGENTS.md.

## 7. Phases and gates

| Phase | Repo | Content | Gate |
|---|---|---|---|
| H1 | host | `PeekRow` identity refactor | The Folder Peek suite passes unchanged, there is no perf regression in `perf:sweep`, and an adversarial review covers selection |
| H2 | host | SDK `entryLineage`, `lineageRows`, Details, pane option, filter suspend, held arrivals, "Select with edits" | Domain tests for every §5 invariant, plus e2e with a test provider: merge duplicates, group rows, zero-blink arrival |
| H3 | host | List cards and Tiles stacked panels | Screenshots for each view, and spatial-nav tests across duplicates |
| P1 | TraceExplorer | Provider, command, mock backend | e2e against the mock backend, a real-folder check (Pokémon), and adversarial review (selection) |

The host releases first. The plugin detects the capability by feature, never by host version.

## 8. Open questions
1. **Tiles depth.** Stacked panels per level (proposed), or one flattened panel per root?
2. **Default.** Should Show traces default to on in traced folders, or off until the user
   enables it?
3. **Expanded state of duplicates.** Shared per path (proposed: the same file opens
   everywhere), or per occurrence?
4. **Ctrl+A.** Depth 0 plus "Select with edits" (proposed), or select every file in the
   folder including closed lineages, at the cost of invisible selections?
