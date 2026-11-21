# Plugin Details columns

The runtime advertises `detailColumns` in its `capabilities` list (#1523). It
is additive: `sdkVersion` and `apiVersion` are unchanged. Detect the
capability or the presence of `ctx.registerDetailColumns`.

```ts
// PluginContext
registerDetailColumns?(provider: DetailColumnProvider): () => void;

export interface DetailColumnProvider {
  /** `<pluginId>.<name>`. */
  id: string;
  /** 1-8 columns; keys match [a-z][a-z0-9-]{0,31}, labels up to 40 chars. */
  columns: readonly { key: string; label: string; width?: number }[];
  /** Synchronous and cheap (an extension test); called per listed entry. */
  applies(entry: FileEntry): boolean;
  /** False when it never supplies lengthSeconds (#1884): it then loads only
   *  while one of its own columns is shown, never for Length or its sort.
   *  Default true. Set it for providers whose loads cost money. */
  suppliesLength?: boolean;
  /** One item per entry, in order; null for an unreadable file. */
  load(entries: readonly FileEntry[], signal: AbortSignal):
    Promise<readonly ({ columns?: Record<string, string>; lengthSeconds?: number } | null)[]>;
}
```

## What the host does

- **Offered only where relevant.** A provider's columns appear in the Details
  header and its column menu only while the listing (including Folder Peek
  rows) contains an entry the provider `applies` to. They follow the built-in
  columns, in plugin order.
- **Lazy values.** Like Length and Resolution, values never enter directory
  listings. Each rendered row requests its entry; requests in the same tick
  share one `load` call of at most 16 entries, with at most two calls in
  flight per provider. Values are cached per path and revision (size +
  mtime): an unchanged file is never reloaded, and a rewritten one is.
  A provider loads only for rows while one of its columns is shown, or while
  Length is shown (any provider may supply `lengthSeconds`), so hiding its
  columns does not stop its loads while Length stays visible. A provider
  declaring `suppliesLength: false` is exempt from both Length loads and the
  folder-wide Length sort.
- **Length.** `lengthSeconds` fills the built-in Length column for files the
  host cannot measure itself (host-probed video durations take precedence).
- **Visibility and width.** Each column is shown until the user hides it from
  the header's context menu; the choice persists per column id
  (`<providerId>:<key>`) in `settings.pluginColumnVisibility`. Widths start at
  `width` (60-4096 px, default 120) and are resizable like built-in columns,
  for the session.
- **Not sortable.** The values exist only for rendered rows, so the host
  cannot order a whole listing by them (the same holds for Length).
- **Bounded, inert output.** Only declared keys are read; values are rendered
  as text (control and bidirectional-override characters replaced, 512
  characters at most). Missing or
  malformed items render empty cells, and a negative or non-finite
  `lengthSeconds` is ignored.
- **Failure isolation.** A throwing `applies` counts as not applying. A
  rejected or throwing `load` leaves that batch's cells empty. The provider's
  first failure is logged under the plugin's name; rendering is never
  interrupted.
- **Lifecycle.** Deactivation aborts in-flight loads (`signal`), forgets
  cached values and removes the columns. Registration validates lazily, so an
  invalid provider is reported rather than thrown (an id outside the plugin's
  namespace still throws).

## Removing one provider (#1884)

`registerDetailColumns` returns a disposer. Calling it removes that provider
before the plugin deactivates: in-flight loads abort, its cached values are
forgotten and its columns leave the header. It is idempotent, safe after
deactivation, and frees the provider id for a new registration. Callers that
ignore the return value keep working. (Hosts before #1884 returned
`undefined`; check the capability below before relying on it.)

## Column-header menu items (#1884)

Capability `detailColumnMenu` adds:

```ts
// PluginContext
registerDetailColumnMenuItem?(item: {
  id: string;            // `<pluginId>.<name>`
  label: string;         // trimmed, at most 80 characters
  run(): void;           // called after the host closes the menu
  enabled?(): boolean;   // read when the menu opens; false shows it disabled
}): () => void;          // disposer
```

Items render in the Details column-header menu after the column toggles,
behind a separator, in plugin order. A throwing `run` is reported under the
plugin's name; a throwing `enabled` counts as disabled. Items are removed on
deactivation or by the disposer. The built-in AI Columns plugin
(`src/lib/plugins/ai-columns`) uses both seams: one provider per described
column, plus Add/Remove items.

## Example

```js
ctx.registerDetailColumns?.({
  id: "bw-replays.header",
  columns: [{ key: "matchup", label: "Matchup", width: 90 }, { key: "map", label: "Map", width: 180 }],
  applies: (entry) => entry.kind === "file" && /\.rep$/i.test(entry.name),
  async load(entries, signal) {
    const { results } = await ctx.backend.invoke("parseReplays", { paths: entries.map((e) => e.path) });
    if (signal.aborted) return entries.map(() => null);
    return results.map((r) => r.error ? null : { columns: { matchup: r.matchup, map: r.map }, lengthSeconds: r.durationSeconds });
  },
});
```

The demo plugin (`src/lib/plugins/demo`) contributes Matchup and Map columns
for its `.demorec` recordings in `demo://`.
