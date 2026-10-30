# Plugin entry lineage (lineage peek)

The runtime advertises `entryLineage` in its `capabilities` list (#1431). It is
additive: `sdkVersion` and `apiVersion` are unchanged. Detect the capability
(or the presence of `ctx.registerEntryLineage`), never a host version.

A contribution says "file X was made from files P, Q" for a folder. The
built-in Details, List and Tiles views then group each file's edits under it,
and the Folder Peek caret reveals them. The host owns the grouping, so the rule
is the same for every provider (`docs/execution-plans/lineage-peek.md` §3).
Plugin file views (such as a graph view) are unaffected.

```ts
// PluginContext
registerEntryLineage?(contribution: EntryLineageContribution): void;

export interface EntryLineageContribution {
  /** `<pluginId>.<name>`, validated like registerFileView ids. */
  id: string;
  /** "Traces" → the pane option "Show traces". */
  title: string;
  /** Whether this directory has lineage; "pending" holds first paint (at most 400 ms). */
  available(directory: string): boolean | "pending";
  /** Lineage for the directory's files. Reject or abort on signal. */
  load(directory: string, signal: AbortSignal): Promise<EntryLineage>;
  /** Call `changed` whenever load() would now return a different revision. Returns an unsubscribe. */
  subscribe?(directory: string, changed: () => void): () => void;
}

export interface EntryLineage {
  /** Opaque; equal revisions mean equal lineage. */
  revision: string;
  /** Path of a file in `directory` → its lineage parents in input order. */
  parents: ReadonlyMap<string, readonly LineageParent[]>;
  /** Optional per-file text, keyed by path (#1449). */
  labels?: ReadonlyMap<string, { prompt?: string; title?: string }>;
}

export type LineageParent =
  | { kind: "entry"; path: string }
  | { kind: "external"; key: string; label: string; thumbnailPath?: string };

// ctx.workspace (both optional):
toggleEntryLineage?(contributionId: string): void;   // "Show <title>" on the active pane
isEntryLineageShown?(contributionId: string): boolean;
```

## What the host does

- **Paths** are absolute, in the listing's `FileEntry.path` form, compared with
  the platform's path rules.
- **Validation.** `entry` parents not in the listing (after hidden-file rules)
  and self-edges are dropped; a parent listed twice counts once. A cycle turns
  grouping off for that folder (it shows flat) and is counted and logged.
  Malformed entries are ignored, never thrown.
- **Grouping.** A child made from P alone sits directly under P. A child whose
  parent set has other members sits under each `entry` parent inside a group
  row for the rest of the set ("with B", "with B, C", "with B, C +2"). External
  parents count in the set, show with a ↗ marker and are keyed by `key`; a file
  whose parents are all external is a root. Group rows come first, sorted by
  label, then direct children in the pane's sort.
- **Resolve missing intermediates yourself.** The host never sees a parent that
  has no file: return the nearest present ancestors instead.
- **Option.** "Show <title>" sits in the context menu's View section and is per
  pane, on by default where `available` is true, and persisted with the pane.
  The host command "Toggle Show Lineage" toggles every offered lineage; a
  plugin may add its own command through `workspace.toggleEntryLineage`.
- **Refresh.** `changed` is debounced per folder (50 ms), so a plugin-wide
  invalidation may call it freely. A load returning the same `revision`
  publishes nothing. First paint holds while `available` is "pending" or the
  first load is in flight (400 ms bound). A new file that the loaded lineage
  does not know is held back for up to 300 ms waiting for `changed`, so a new
  edit does not flash at the top level and then jump under its parent.
- **Selection** stays a set of paths. A merge output listed under two parents
  highlights at both, and file operations receive it once. Ctrl+A selects the
  top level; "Select with Edits" adds every lineage descendant of the
  selection (opening those lineages). A name filter suspends grouping.
- **Labels (optional, #1449).** Detect by feature: when `labels` is present
  the host adds a Details "Prompt" column (hideable, resizable, sortable by
  text) showing each file's `prompt` (else `title`; "—" for files without
  text), and labels lineage children (depth > 0 beneath a file or a group
  row, never beneath a folder peek) by `title`, else `prompt`. Depth 0 keeps
  filenames, and the tooltip, Preview pane and status bar keep the filename.
  Rename, typeahead and file operations use filenames; the name filter also
  matches prompt text. Text is collapsed to one line and bounded; empty or
  non-string values fall back to the filename. Without `labels` nothing
  changes. List and Tiles do not show labels yet.
- **Group rows** are not files: never selected or dragged; a drop on one
  targets the current folder. A click toggles the group and previews the
  parents it combines.
