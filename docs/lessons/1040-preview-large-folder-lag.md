# #1040 — Previewing a huge folder lagged the UI

**Symptom:** selecting a folder with thousands of entries froze the app while
the Preview pane rendered it.

**Cause:** the folder/ZIP children list in the Preview pane was a plain
`{#each}` — one row plus one `FileIcon` component per child. A 5000-entry
folder mounted 5000 components in one go. The file list itself was already
virtualized, so only the preview lagged.

**Fix:** the list lives in `components/PreviewFolderList.svelte` and renders
its rows through the shared `VirtualList` (fixed 24px rows). The container is a
flex column with `min-height: 0` and the viewport gets `min-height: 0` too —
without it the viewport grows to full content height and every row renders
again (the same trap as #469).

**Testing seam:** the gated suite is Vitest, so the regression test renders
`PreviewFolderList` with `svelte/server` (`tests/components/preview-folder-list.test.ts`).
On the server `VirtualList` has a zero viewport height and renders only its
buffer rows, which is enough to tell "windowed" from "every row". The real
layout/scroll outcome is covered in the browser by
`e2e/folder-preview-virtualization.spec.ts`, which uses the mock's nested
`/perf/huge-N/folder-00000` path (any `/perf/huge-…` subpath lists 5000
synthetic entries).
