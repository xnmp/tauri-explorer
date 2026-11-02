# #1491 — special folder icons

- **Startup budget.** The name table, per-pack variants, renderer and glyph
  sprite load lazily (`components/icons/special-folder-icons.svelte.ts` →
  `SpecialFolderArt.svelte`). Even so, the seam, Vite's preload wrapper and two
  dynamic component mounts cost ~400 bytes gzip; the cap was raised by 256 with
  a note in `scripts/check-bundle-size.mjs`.
- **Shared asset URLs split chunks.** Importing `catppuccin-sprite.svg?url` from
  the lazy chunk turned the URL into its own startup chunk (+576 bytes gzip).
  CatppuccinFileIcon passes its sprite URL down as a prop instead. Likewise,
  `domain/special-folders.ts` does not import `getFolderDecoration` (a static
  edge to a startup module split that module out too).
- **Scoped CSS stamps every matched element.** A scoped rule like
  `.folder-icon > svg > path` added `class="svelte-…"` to every folder path in
  the startup template (+hundreds of bytes). Use `:global(...)` for the
  descendant part when the selector exists only to hide host paths.
- **Custom properties resolve where they are declared.** Setting
  `--icon-pack-tint` on a `<use>` does not change `--vscode-ctp-*` computed on
  the icon span. CatppuccinFileIcon re-declares the palette on
  `.special-folder-art` so the glyph keeps its own accent while the folder
  outline keeps the theme folder colour.
- **Tiles peek caret.** Catppuccin's upstream composites put the glyph in the
  bottom-right corner, under the caret. Large icons therefore centre a
  glyph-only symbol (build script strips just the shared outline) on the plain
  folder; small icons, which never carry a caret, use the composite unchanged.
- **Vitest/Vite under `.claude/worktrees/`.** rolldown's tsconfig lookup skips the
  dot-directory worktree and falls back to the parent checkout's missing
  `.svelte-kit/tsconfig.json`; run builds/tests from a copy at a non-dot path.
