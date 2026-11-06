# Plugin file icons

The runtime advertises `fileIcons` in its `capabilities` list (#1523). It is
additive: `sdkVersion` and `apiVersion` are unchanged. Detect the capability
or the presence of `ctx.registerFileIcon`, never a host version.

```ts
// PluginContext
registerFileIcon?(icon: FileIconContribution): void;

export interface FileIconContribution {
  /** `<pluginId>.<name>`, validated like registerFileView ids. */
  id: string;
  /** Extensions without the dot (1-32), matched case-insensitively: ["rep"]. */
  extensions: readonly string[];
  /** Self-contained <svg> markup with its own colours, at most 16 KiB. */
  svg: string;
  /** Details Type column text for these files, e.g. "StarCraft replay". */
  typeName?: string;
}
```

## What the host does

- The icon replaces the built-in artwork for matching **files** in every view
  and icon pack: Details, List, Tiles, Folder Peek, Miller columns, Quick Open
  and the file picker all render `FileIcon`. Folders are never overridden.
- The artwork is rendered as an `<img>` `data:` URI at 16 px (rows) or 64 px
  (tiles). An image context runs no script, loads no external resource and
  cannot read or restyle the host, so draw with explicit colours rather than
  `currentColor` or host CSS variables. The host adds the SVG namespace when
  the markup omits it.
- Plugin icons get no CSS filter: built-in icons carry a small drop shadow,
  but a filtered `<img>` is re-rasterized on every scroll frame in WebKitGTK
  (Tiles frames went from ~17 ms to 120-190 ms, #1530). Draw any shading
  into the artwork itself.
- Extensions are owned by the first plugin in plugin order. When it
  deactivates, the next claimant (or the built-in icon) takes over.
- Registration validates in a lazily loaded module. An invalid contribution
  (no or malformed extensions, markup that is not one `<svg>` element, over
  16 KiB) is reported under the plugin's name and not registered, rather
  than thrown. An id outside the plugin's namespace still throws synchronously.
- `typeName` is trimmed, stripped of control and bidirectional-override
  characters and capped at 64
  characters.

## Example

```js
ctx.registerFileIcon?.({
  id: "bw-replays.rep",
  extensions: ["rep"],
  svg: "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>…</svg>",
  typeName: "StarCraft replay",
});
```

The demo plugin (`src/lib/plugins/demo`) registers one for its `.demorec`
recordings in `demo://`.
