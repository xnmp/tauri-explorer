# #1499 — special folder icons everywhere

- **Surfaces that render FileIcon got it for free.** Miller columns, Quick
  Open, the file picker and the preview folder list already pass real
  directory entries to FileIcon; only surfaces drawing their own inline folder
  SVG by name (tab bar, sidebar bookmark/recent rows, history menu, collapsed
  preview root) needed work. They resolve `specialFolderIconEntry(name)` (a
  synthetic directory entry, or null to keep the host's art) through the lazy
  seam, re-exported from `SpecialFolderArt.svelte`'s module script so it stays
  in the same lazy chunk; a second dynamic import would split it out.
- **Disambiguated tab titles are not folder names.** Two `src` tabs get
  disambiguated titles that no longer match `src`; `TabDisplay.folder` carries the raw single-pane
  folder name. Git-mode tabs keep the git icon; multi-pane tabs stay plain.
- **Startup budget (no cap raise).** A component shared by a startup module
  and a lazy one becomes its own startup chunk (+~150 bytes gzip). The lazy
  hosts (`PreviewFolderList`, `NavigationHistoryMenu`) therefore inline
  FileIcon rather than import `NamedFolderIcon`, and the history menu itself
  now loads on first right-click: dev 280,948 → 280,979 of 281,024.
- **Scoped classes passed to a child component do not match.** The wrapper
  span's `class` comes from the host but is rendered by NamedFolderIcon, so
  host styles for it need `:global(...)`. Sidebar wrappers also carry
  `data-region="sidebar-icon"` so layouts (hairline-ledger) treat them like
  the inline SVGs, and `data-drag-icon` for the pointer-drag ghost.
