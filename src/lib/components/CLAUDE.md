# Component rules

Root `CLAUDE.md` holds the cross-cutting rules (three view modes, refresh split,
no state in component scope). Rules for components that live elsewhere:
Git graph → `src/lib/components/git-graph/CLAUDE.md`; terminal key ownership (`TerminalPanel.svelte`)
→ `src/lib/domain/CLAUDE.md`; window titles and new-window address-bar focus
(`BreadcrumbAutocomplete`) → `src/lib/state/CLAUDE.md`; user-report attachments
(`UserReportDialog.svelte`) → `website/api/CLAUDE.md`; drive opening →
`src-tauri/src/files/CLAUDE.md`.

## File-list views and panes

- Details-only columns (e.g. Length, #995) are the exception to "all three view modes": their values are lazy per-row metadata requested by rendered `FileItem` rows through a cached resolver, never fields on directory listings.
- Keep high-frequency hover feedback on file entries, sidebar navigation, and tabs immediate. Preserve motion for one-shot structural events (such as tab enter/close), but do not add CSS transition settling to pointer highlights; it reads as input latency even when the main thread is idle (#503).
- Pane focus is **state, not DOM focus**: `ExplorerPane` gates its window-level keydown listener on `windowTabsManager.activePaneId === paneId`, so moving focus between panes is `setActivePane` alone — calling `.focus()` on the pane element is neither necessary nor sufficient. Assert on `.explorer-pane.active`, not on `document.activeElement`.
- Recently active window tabs stay mounted as hidden, inert `.pane-tree.retained` layers (`domain/retained-tabs.ts`, #1173), so a tab switch only toggles visibility. Their rows, panes and per-pane effects are live while hidden: scope DOM queries and E2E locators to the shown tab (`.pane-tree:not(.retained)` or Playwright `:visible`), and gate window-level per-pane handlers on manager state such as `activePaneId`, never on being mounted.
- ExplorerPane owns window-level file-list shortcuts, but FileList owns each virtualized view's scroller. Selection jumps that can target an unmounted row must use FileList's bound `scrollToEntry` seam so the selected entry is rendered and visible before focus moves to it.
- Never size painted layout from a ResizeObserver measurement committed in a later frame: the pane canvas fills its scrollport and split children flex by saved ratio, both in CSS with only `paneMinima` from script; measured `paneViewport.geometry` serves reveal/focus/divider input/ARIA. Files grid width updates still render within ResizeObserver delivery (`flushSync`) (#1061). See `docs/lessons/1061-tile-layout-delivery.md`.
- The marquee band is five container-sized layers that only ever change `transform` (`domain/marquee-rect.ts`). Writing `width`/`height` on a band element resizes a composited layer every pointer frame, and WebKitGTK repaints it over every image tile beneath, so drag-selecting in a large picture folder trailed the pointer (#1051). Keep the layers container-sized (the client box, so scale stays about ≤ 1): a 1px base rasterises to a whole device pixel under fractional zoom and paints the band too small while DOM measurements still look right. Tests read the band through `getBoundingClientRect()`, which includes the transform, and sample pixels at 130% zoom.
- Repository-folder Git badges read `--icon-git-badge` from each active theme; keep it distinct from `--icon-folder` (the Hacker theme deliberately uses its darker terminal green) and cover every file-list view mode when changing it.
- Repository-folder Git badges are rendered directly by `FileIcon.svelte` in every directory view. Keep their compact corner geometry and their `--icon-git-badge` / `--icon-git-badge-glyph` theme overrides together when polishing the SVG (#601).

## Details view

- Details header column menus use `fixedMenuPosition` to convert pointer, viewport and rendered menu dimensions through `fixedFromClient`; legacy WebKit scales offsets twice but sizes once. Their synchronous mounted geometry probe selects single/double offset scaling relative to size scaling, supporting newer WebKit alongside native WebKit's legacy model without changing other overlays. Stop the header contextmenu event from bubbling into FileList, or its background menu covers the column controls (#993).

### Details image metadata (#994)

Resolution uses `files::image_resolution::get_image_resolution`, a header-only
read for PNG/JPEG/GIF/WebP/BMP (4 shared native slots, at most 1 MiB of input).
Do not derive it from thumbnail dimensions or add it to eager directory scans.
Virtualized cells own cancellable requests through `state/image-resolution.ts`.
Directory reconciliation can retain entry identity when byte count and mtime are
unchanged, so metadata must also invalidate through shared directory-change and
local-mutation events. Header context-menu events must stop propagation to avoid
opening the pane's file menu over the column menu.
Details rows reveal their outer edge only on visible keyboard entry from outside
the row grid. Native Tab focus can scroll clipping ancestors and hide the file
identity at high zoom; aligning the outer edge also preserves its leading ring.
Pointer selection and cursor moves within the grid must retain the user's
horizontal column position and FileList's preventScroll ownership (ADR 0015).
Do not relax the icon viewport, focus-ring or horizontal-scroll assertions.

A virtual cursor jump can unmount the old focused row before FileList focuses
its replacement. A null relatedTarget is not proof of external keyboard entry;
keep its preventScroll behavior and require a known external focus origin for
the native Tab reveal. Cover scrolled Ctrl+End/Home as well as mounted arrows.

Details Length and Resolution are independent keyed columns. Keep header, row,
width projection and saved visibility defaults in the same order; tests compare
the complete defaults and verify that resizing or hiding one preserves the other.

## Overlays, menus and dialogs

- Fixed overlays under root CSS zoom are engine-specific: `fixedFromClient` and `fixedFromRect` divide once only on Chromium; WKWebView uses two divisions, while WebKitGTK's CSS-space rect offsets its second scale. Keep the live Chromium check wired through the context-menu conversion (#493).
- Plugin context-menu actions that invoke an AI service carry `group: "ai"`; `ContextMenu.svelte` renders those applicable actions in its shared AI submenu while leaving non-AI plugin actions top-level.
- The Theme from Image context-menu action also belongs in that shared AI submenu, even though palette extraction runs locally; keep its single, real-image selection predicate intact.
- Shortcut hints in command-owned UI must come from `getCommandShortcut(commandId)`, not hardcoded defaults, so persisted overrides and unbound commands remain consistent with window command dispatch.
- Progress toasts must bypass the generic opacity entrance animation so accepted long-running work is visible immediately. Under load, WebKit can strand an entrance animation on its zero-opacity first frame; keep motion on the progress spinner instead.
- The floating update notice uses the shared `modal-card` and `btn` control chrome; import `components/modal.css` in `UpdateNotice.svelte` so the globally scoped dialog styles accompany the otherwise standalone notice.

### About command (#755)

The About surface uses the existing `AppInfo` contract and `getAppInfo()` bridge
(`get_app_info` returns the packaged Rust version). Keep this optional dialog
lazy-loaded through `WindowDialogs.svelte`, with modal ownership provided by
`Modal.svelte`; do not read package.json for the running application version.
The store must include About in `hasModalOpen` and `closeAll`, including while
its lazy import is pending. Payload-free dialogs are ids in `domain/overlays.ts`
(`OVERLAY_IDS`); `anyModalOpen`, `closeUnmountedDialogs` and `closeAll` iterate
that registry, so add the id plus its open/close methods and extend the typed
opener table in `tests/state/dialog-registry.test.ts`. The command declares window scope for destination admission.
Browser evidence for this surface must finish CSS
animations (`page.screenshot({ animations: "disabled", ... })`): a visible DOM
assertion can succeed on the first transparent frame of the shared modal fade.

## SCM

- SCM archive actions preserve each repo-relative path under `.archive/` and add `.archive` to `.gitignore`; this keeps archived files out of the Untracked list.

## Drag and drop

- Bookmarks have two drop surfaces: a specific `.bookmark-drop-target[data-path]` preserves bookmark identity so files transfer into it but folders pin, while empty `.quick-access` space remains a folder-pinning target. Resolve the row before its containing section so Linux native and macOS/Windows pointer drags agree (#675). Feedback wording: `src/lib/domain/CLAUDE.md`.

## Previews

Preview content loading and video frames: `src/lib/state/CLAUDE.md`. Markdown
frontmatter: `src/lib/domain/CLAUDE.md`.

- Zoomed image previews update their `transform` for every pointer move. Keep the compositor hint scoped to `.preview-image.zoomed`, so active panning stays smooth without retaining layers for every ordinary image preview (#635).
- Vertical preview docks retain the persisted preferred height, but their rendered wrapper caps it to the center stack's available height minus a usable file region. Keep that allocation in the shared page layout rather than component-local resize state so zoom and window resizing cannot feed back into saved settings (#699).
- Markdown preview content is inserted with `{@html}` in `PreviewPane.svelte`, so its element styles require `:global(...)`; keep heading and link colours on the existing theme variables and verify their computed colours in the browser.
- Fullscreen PDF horizontal arrows use `PdfPreview`'s page selection before zoomed pan or sibling navigation. Interactive-target guards belong in its shared key handler: excluding links only from window capture still lets their events bubble into the viewport handler (#1010).

CSV previews must parse the complete bounded read before applying their record
limit: splitting physical lines first corrupts valid quoted newlines. Keep the
CSV branch separate from the existing Markdown/text paths and virtualize its
record rows with `VirtualList` (#666).

HTML previews use a sandboxed `srcdoc` iframe in `HtmlPreview.svelte`, with no
script or same-origin permission and a restrictive CSP before file content.
Keep HTML on the bounded async reader in `preview-content.ts`, bypassing source
highlighting and its 200-line truncation (which can cut document structure).
Remote/relative assets and scripts are intentionally unavailable; inline styles
and embedded data images remain supported. Assert rendered content through the
browser frame, not Explorer's DOM (`e2e/html-preview.spec.ts`, #1332).
HTML preview zoom cannot measure the sandboxed document, so it scales a fixed
desktop layout like an image (`domain/html-preview-zoom.ts`): the frame lays out
the Fit width (max(1280, pane)) at every magnification and zoom only scales its paint; Fit shows it whole, zooming
in scrolls the pane horizontally, and the frame's height stays in CSS
(`calc(100% / scale)`) because `bind:clientHeight` misses scrollbar changes.
Re-laying out at pane / scale (browser zoom) reflowed responsive pages at every
step (#1361). Do not add `allow-same-origin` to measure content width (#1352).
CSP browser-test rules for this surface: `e2e/CLAUDE.md`.
