<!--
  PreviewPane component - File preview panel
  Issue: tauri-explorer-2c6b, tauri-explorer-xago, tauri-explorer-osjq
-->
<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { useControlledSize } from "$lib/composables/use-controlled-size.svelte";
  import { previewResizeSpec } from "$lib/domain/preview-size";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { PreviewImageOptions } from "$lib/state/preview-image";
  import { createPreviewContentLoader, type PreviewContent } from "$lib/state/preview-content";
  import { classifyPreview } from "$lib/domain/preview-kind";
  import { needsFullResolution, renditionMaxEdge } from "$lib/domain/preview-rendition";
  import { createLatestOnlyRunner } from "$lib/domain/latest-only";
  import { usePreviewFullscreen } from "$lib/composables/use-preview-fullscreen.svelte";
  import PreviewImageSurface from "./PreviewImageSurface.svelte";
  import { getFileType, formatDate } from "$lib/domain/file-types";
  import VideoIndicator from "./VideoIndicator.svelte";
  import { formatResolution, formatSize, isSystemHidden, type FileEntry } from "$lib/domain/file";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { frecencyStore } from "$lib/state/frecency.svelte";
  import { getScmStore } from "$lib/state/scm.svelte";
  import HtmlPreview from "./HtmlPreview.svelte";
  import type { HtmlZoom } from "$lib/domain/html-preview-zoom";
  import { subscribeToLocalFileChanges } from "$lib/state/file-events";
  import { parentDir } from "$lib/domain/path";
  let localPreviewRevision = $state(0);
  const unsubscribePreviewChanges = subscribeToLocalFileChanges((directories) => {
    if (selectedFile && directories.includes(parentDir(selectedFile.path))) localPreviewRevision++;
  });
  onDestroy(unsubscribePreviewChanges);

  // Window-global surface: the preview's SCM diff follows the ACTIVE pane's
  // store (#334) — reactive through windowTabsManager.activePaneId.
  // The active pane's SCM store — but the SIDEBAR scm view has no pane
  // context and writes its diffs to the "default" store, so clicking a
  // change there never reached the preview pane (#386). Read whichever
  // store actually holds an open diff, preferring the pane's.
  const paneScmStore = $derived(getScmStore(windowTabsManager.activePaneId || "default"));
  const sidebarScmStore = $derived(getScmStore("default"));
  const scmStore = $derived.by(() => {
    if (paneScmStore.activeDiff || paneScmStore.commitDiff) return paneScmStore;
    if (sidebarScmStore.activeDiff || sidebarScmStore.commitDiff) return sidebarScmStore;
    return paneScmStore;
  });
  import { useLightTheme } from "$lib/composables/use-light-theme.svelte";
  import PreviewDiffView from "./PreviewDiffView.svelte";
  import PreviewCsvTable from "./PreviewCsvTable.svelte";
  import PreviewTextDocument from "./PreviewTextDocument.svelte";
  import PreviewFolderList from "./PreviewFolderList.svelte";
  import PluginPreviewTarget from "./PluginPreviewTarget.svelte";
  import { previewInfoRegistry, type PreviewSubject } from "$lib/plugins/preview-registry.svelte";
  /** Light/dark hljs palette for markdown and code previews. */
  const lightTheme = useLightTheme();

  const paneId = $props.id();
  const position = $derived(settingsStore.resolvedPreviewPanePosition);
  const isVertical = $derived(position !== "right");
  // The final write can run after destruction. Read live settings directly;
  // a derived captured by the destroyed view is not a durable source of truth.
  const readSizeSpec = () => previewResizeSpec(settingsStore.resolvedPreviewPanePosition);
  const resize = useControlledSize(() => settingsStore[readSizeSpec().setting], value => {
    if (readSizeSpec().setting === "previewPaneWidth") settingsStore.setPreviewPaneWidth(value);
    else settingsStore.setPreviewPaneHeight(value);
  }, () => readSizeSpec().options);

  // --- Fullscreen preview (double-click to toggle, Esc to exit) ---
  // One controller for file images and plugin Preview targets (#1033); see
  // use-preview-fullscreen. At base zoom, Left/Right step to the previous/next
  // previewable sibling file; a plugin target has no siblings, so they do nothing.
  const fullscreen = usePreviewFullscreen({
    onToggle: () => resize.cancel(),
    navigate: (delta) => navigateSibling(delta),
    // PDF and video previews own their keys in fullscreen; only Esc stays ours.
    subjectOwnsKeys: () => selectedKind === "pdf" || selectedKind === "video",
    // Text, markdown and code zoom with the wheel and scroll with Up/Down (#1039).
    subjectZoomsText: () => textZoomable,
    scrollSubject: (dy) => previewContentEl?.scrollBy({ top: dy }),
  });

  let previewContentEl = $state<HTMLElement | null>(null);

  function handlePaneDoubleClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(
      'button, a, input, textarea, select, [contenteditable], [role="separator"], .preview-image-container, .pdf-preview, .video-preview, video, audio, iframe',
    )) return;
    // A plugin target is fullscreen-able only as an image (a diff, when open,
    // is shown instead of the target). Leaving fullscreen is always allowed.
    const showsTarget = pluginTarget && !activeDiff && !commitDiff;
    if (!fullscreen.active && showsTarget && !pluginTarget.target.imagePath) return;
    fullscreen.toggle();
  }

  /** Step to the previous/next previewable (non-directory) sibling file. */
  function navigateSibling(delta: number): void {
    const explorer = windowTabsManager.getActiveExplorer();
    if (!explorer || !selectedFile) return;
    const files = explorer.displayEntries.filter((e) => e.kind !== "directory");
    if (files.length === 0) return;
    const idx = files.findIndex((e) => e.path === selectedFile!.path);
    if (idx < 0) return;
    const next = files[(idx + delta + files.length) % files.length];
    explorer.selectEntry(next);
    fullscreen.resetZoom();
  }

  /** Currently selected file from the active explorer. A marquee drag only
   *  updates it when the drag ends: loading every file the band crosses
   *  stalled the drag (#1169). */
  const selectedFile = $derived.by((): FileEntry | null => {
    const explorer = windowTabsManager.getActiveExplorer();
    if (!explorer) return null;
    const selected = explorer.getSettledSelectedEntries();
    return selected.length === 1 ? selected[0] : null;
  });

  // SDK 2: a plugin's non-file Preview subject for the active pane. A file
  // selection always takes precedence (the pane clears targets on selection).
  const pluginTarget = $derived.by(() => {
    if (selectedFile) return null;
    return windowTabsManager.getActiveExplorer()?.previewTarget ?? null;
  });
  const previewSubject = $derived.by((): PreviewSubject | null => {
    const paneId = windowTabsManager.activePaneId || null;
    if (pluginTarget) return { kind: "target", target: pluginTarget.target, pluginId: pluginTarget.owner, paneId };
    return selectedFile ? { kind: "file", entry: selectedFile, paneId } : null;
  });
  const infoSections = $derived(previewSubject && settingsStore.showPreviewInfo ? previewInfoRegistry.itemsFor(previewSubject) : []);

  /** Stable primitive that changes when the selected path OR its mtime changes,
   * so external edits to the same file invalidate the cached preview. */
  const selectedKind = $derived(selectedFile ? classifyPreview(selectedFile) : null);
  const selectedPath = $derived(selectedFile?.path ?? null);
  // Every newly selected document starts at Fit; a reload of the same path
  // (watcher refresh after a save remounts HtmlPreview) keeps the zoom.
  let htmlZoom = $derived.by<HtmlZoom>(() => {
    void selectedPath;
    return "fit";
  });
  const previewKey = $derived(
    selectedFile ? `${selectedFile.path}|${selectedFile.modified}|${selectedFile.size}|${localPreviewRevision}` : null,
  );

  // One replacement owns all format data, loading/held state and errors.
  let content = $state<PreviewContent<
    typeof import("./PdfPreview.svelte").default,
    typeof import("./VideoPreview.svelte").default
  >>({ kind: "empty" });
  const contentLoader = createPreviewContentLoader((url) => URL.revokeObjectURL(url), {
    pdf: async () => (await import("./PdfPreview.svelte")).default,
    video: async () => (await import("./VideoPreview.svelte")).default,
  });
  // Audio-cover dimensions remain DOM measurements, keyed by URL. File images
  // carry source pixels with their versioned content, including renditions.
  let previewImageSize = $state<{ url: string; width: number; height: number } | null>(null);
  const previewResolution = $derived(
    content.kind === "image" && !content.held && content.sourceSize
      ? formatResolution(content.sourceSize.width, content.sourceSize.height)
      : content.kind === "audio-cover" && !content.held && previewImageSize?.url === content.url
        ? formatResolution(previewImageSize.width, previewImageSize.height) : "",
  );
  let previewContentWidth = $state(0);
  let previewContentHeight = $state(0);
  const renditionRunner = createLatestOnlyRunner();
  const previewFolderChildren = $derived.by(() => {
    if (content.kind !== "directory" && content.kind !== "zip") return [];
    return settingsStore.showHidden ? content.entries
      : content.entries.filter((e) => !e.name.startsWith(".") && !isSystemHidden(e.name));
  });
  const previewLoading = $derived(content.kind === "loading" ||
    ((content.kind === "image" || content.kind === "audio-cover") && content.held));
  // Image metadata keeps its geometry while loading and when source pixels
  // are unavailable, without attributing held dimensions to the new selection.
  const showResolutionRow = $derived(
    (selectedKind === "image" || selectedKind === "audio-cover") &&
    (previewLoading || content.kind === "image" || content.kind === "audio-cover"),
  );
  // Defer the spinner: a preview that resolves in under 150ms shouldn't flash
  // a spinner. Show it only once loading has been pending long enough to read.
  let showPreviewSpinner = $state(false);
  $effect(() => {
    if (!previewLoading) {
      showPreviewSpinner = false;
      return;
    }
    const timer = setTimeout(() => (showPreviewSpinner = true), 150);
    return () => clearTimeout(timer);
  });
  let lastPreviewKey: string | null = null;

  // --- Git diff preview state ---
  const activeDiff = $derived(scmStore.activeDiff);
  // Commit file diff routed from the git graph (#366); wins over the
  // working-tree diff when both are somehow set (openers clear the other).
  const commitDiff = $derived(scmStore.commitDiff);

  /** The branch of the template that shows reflowing text: the only subject whose fullscreen zoom is a font zoom. */
  const textZoomable = $derived(
    !!selectedFile && !activeDiff && !commitDiff &&
    (content.kind === "markdown" || content.kind === "code" || content.kind === "text"),
  );

  // Clear activeDiff when explorer file selection changes (not on initial render)
  let prevSelectedPath: string | null = null;
  $effect(() => {
    const current = selectedPath;
    if (prevSelectedPath !== null && current !== prevSelectedPath && activeDiff) {
      scmStore.closeDiff();
    }
    prevSelectedPath = current;
  });

  // Load preview when selection (or selected file's mtime/size) changes.
  $effect(() => {
    const path = selectedPath;
    const key = previewKey;
    const file = selectedFile;
    if (!file || !path) {
      content = contentLoader.clear();
      lastPreviewKey = null;
      return;
    }
    if (key === lastPreviewKey) return;
    lastPreviewKey = key;
    loadPreview(file);
  });

  // Fullscreen/zoom upgrades the shown rendition without blanking it.
  const wantsFullResolution = () => needsFullResolution({ fullscreen: fullscreen.active, zoom: fullscreen.zoom });
  $effect(() => {
    const source = content;
    if (source.kind !== "image" || !source.rendition || !wantsFullResolution()) return;
    void contentLoader.upgrade(source, wantsFullResolution).then((upgraded) => {
      if (upgraded && content === source && wantsFullResolution()) content = upgraded;
    });
  });

  /** The image request for `file`: a rendition sized for the surface, or the
   * original while the viewer needs full resolution. Read untracked: the
   * load effect must not re-run when the pane resizes or zooms. */
  function imageLoadOptions(): PreviewImageOptions {
    return untrack(() => {
      if (needsFullResolution({ fullscreen: fullscreen.active, zoom: fullscreen.zoom })) return {};
      const maxEdge = renditionMaxEdge({
        width: previewContentWidth,
        height: previewContentHeight,
        devicePixelRatio: window.devicePixelRatio,
        zoom: settingsStore.zoomLevel / 100,
      });
      return { rendition: { maxEdge, runner: renditionRunner } };
    });
  }

  function loadPreview(file: FileEntry): void {
    if (file.kind !== "directory") frecencyStore.recordFileAction(file.path);
    // Reads inside the loader must not subscribe the selection effect to the
    // content it replaces (including a held image) or the viewer's geometry.
    untrack(() => void contentLoader.load(file, content, {
      localRevision: localPreviewRevision, imageOptions: imageLoadOptions(),
    }, next => { content = next; }));
  }

  onDestroy(() => contentLoader.dispose());
</script>

<!-- The dock slot holds the preview's docked size in the layout, whether or
     not the pane is in it: fullscreen lifts only the pane out of flow, so the
     workspace panes keep the size they have while the preview is docked. -->
<div
  class="preview-dock"
  class:vertical={isVertical}
  style={isVertical ? `height: ${resize.value}px;` : `width: ${resize.value}px;`}
>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  id={paneId}
  class="preview-pane"
  data-region="preview-body"
  data-fullscreen={fullscreen.active || undefined}
  class:resizing={resize.isResizing}
  class:fullscreen={fullscreen.active}
  class:vertical={isVertical}
  class:dock-bottom={position === "bottom"}
  class:dock-top={position === "top"}
  style={`--preview-font-size: ${settingsStore.previewFontSize}px;`}
  ondblclick={handlePaneDoubleClick}
>
  {#if !fullscreen.active}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator is an interactive range. -->
    <div class="resize-handle" role="separator" tabindex="0" aria-label="Resize preview"
      aria-orientation={isVertical ? "horizontal" : "vertical"} aria-controls={paneId}
      aria-valuemin={resize.min} aria-valuemax={resize.max} aria-valuenow={resize.value}
      aria-valuetext={`${Math.round(resize.value)} pixels`}
      onpointerdown={resize.startResize} onpointermove={resize.move} onpointerup={resize.finish}
      onpointercancel={resize.cancelPointer} onlostpointercapture={resize.cancelPointer}
      onkeydown={resize.keydown}></div>
  {/if}
  {#if fullscreen.active}
    <button class="fullscreen-exit" onclick={(e) => { e.stopPropagation(); fullscreen.exit(); }} title="Exit full screen (Esc)" aria-label="Exit full screen">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </button>
    {#if textZoomable}
      <div class="fs-text-zoom-indicator">{Math.round(fullscreen.zoom * 100)}%</div>
    {/if}
  {/if}
  {#if activeDiff || commitDiff}
    <PreviewDiffView {scmStore} />
  {:else if pluginTarget}
    {#key pluginTarget.target.id}
      <PluginPreviewTarget target={pluginTarget.target} showInfo={settingsStore.showPreviewInfo} {fullscreen}>
        {#snippet sections()}{@render previewSections()}{/snippet}
      </PluginPreviewTarget>
    {/key}
  {:else if !selectedFile}
    <div class="preview-empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.25"/>
        <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.25"/>
      </svg>
      <span>Select a file to preview</span>
    </div>
  {:else}
    <!-- Auxiliary metadata (name + type badge, and the size/modified footer
         below) is opt-out for a minimal, content-only preview (#494). -->
    {#if settingsStore.showPreviewInfo}
      <div class="preview-header">
        <span class="preview-filename" title={selectedFile.path}>{selectedFile.name}</span>
        <span class="preview-type-badge">{getFileType(selectedFile)}</span>
      </div>
    {/if}

    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a scrollable region must be keyboard-focusable (WCAG 2.1.1, #797). -->
    <div class="preview-content" class:fs-text={fullscreen.active && textZoomable}
      style:--fs-text-zoom={fullscreen.zoom}
      onwheel={textZoomable ? fullscreen.wheel : undefined}
      role="region" aria-label="Preview of {selectedFile.name}{selectedKind === "video" ? ' (video)' : ''}" aria-busy={previewLoading} tabindex="0"
      bind:this={previewContentEl} bind:clientWidth={previewContentWidth} bind:clientHeight={previewContentHeight}>
      {#if selectedKind === "video"}
        <span class="video-preview-marker"><VideoIndicator /></span>
      {/if}
      {#if content.kind === "loading"}
        {#if showPreviewSpinner}
          <div class="preview-loading"><div class="spinner"></div></div>
        {/if}
      {:else if content.kind === "pdf"}
        {#key content.key}
          <content.component path={content.path} name={selectedFile.name} fullscreen={fullscreen.active}
            ontogglefullscreen={fullscreen.toggle} onnavigate={navigateSibling} />
        {/key}
      {:else if content.kind === "video"}
        {#key content.key}
          <content.component path={content.path} name={content.name} fullscreen={fullscreen.active} ontogglefullscreen={fullscreen.toggle} />
        {/key}
      {:else if content.kind === "image" || content.kind === "audio-cover"}
        <PreviewImageSurface src={content.url} alt={selectedFile.name} {fullscreen}
          onresolution={(url, width, height) => (previewImageSize = { url, width, height })}>
          {#if content.note}<p class="image-preview-note">{content.note}</p>{/if}
          {#if content.held && showPreviewSpinner}
            <div class="preview-loading preview-loading-over-image"><div class="spinner"></div></div>
          {/if}
        </PreviewImageSurface>
      {:else if content.kind === "directory" || content.kind === "zip"}
        {#if previewFolderChildren.length > 0}
          <PreviewFolderList entries={previewFolderChildren} collapsedRoot={content.collapsedRoot} collapsedNote={content.collapsedNote} />
        {:else}
          <div class="preview-empty"><span>No preview available</span></div>
        {/if}
      {:else if content.kind === "csv"}
        <PreviewCsvTable csv={content.csv} />
      {:else if content.kind === "html"}
        <HtmlPreview source={content.document} zoom={htmlZoom}
          onzoom={(zoom) => (htmlZoom = zoom)}
          fullscreen={fullscreen.active} ontogglefullscreen={fullscreen.toggle} />
      {:else if content.kind === "markdown" || content.kind === "code" || content.kind === "text"}
        <PreviewTextDocument {content} light={lightTheme.light} />
      {:else if content.kind === "error"}
        <div class="preview-empty"><span class="preview-error-text">{content.message}</span></div>
      {:else}
        <div class="preview-empty"><span>No preview available</span></div>
      {/if}
      {#if "truncatedLines" in content && content.truncatedLines > 0}
        <div class="preview-truncated">Showing first 200 of {content.truncatedLines.toLocaleString()} {content.truncatedLabel}</div>
      {/if}
    </div>

    {#if settingsStore.showPreviewInfo}
      <div class="preview-info">
        {#if selectedFile.kind === "file"}
          <div class="info-row">
            <span class="info-label">Size</span>
            <span class="info-value">{formatSize(selectedFile.size)}</span>
          </div>
        {/if}
        {#if showResolutionRow}
          <div class="info-row">
            <!-- Short label: vertical docks give the metadata column ~80px, and a
               longer one squeezes the figures to a sliver (#1118). -->
            <span class="info-label">Pixels</span>
            <span class="info-value">{previewResolution || "—"}</span>
          </div>
        {/if}
        <div class="info-row">
          <span class="info-label">Modified</span>
          <span class="info-value">{formatDate(selectedFile.modified)}</span>
        </div>
      </div>
      {@render previewSections()}
    {/if}
  {/if}
</div>
</div>

{#snippet previewSections()}
  {#if infoSections.length && previewSubject}
    <div class="preview-sections">
      {#each infoSections as section (`${section.pluginId}:${section.id}`)}
        <svelte:boundary onerror={(error) => console.error(`[plugins] preview info ${section.id} failed:`, error)}>
          <section.component {...section.props} subject={previewSubject} />
          {#snippet failed()}<p class="preview-section-error">This section could not be displayed.</p>{/snippet}
        </svelte:boundary>
      {/each}
    </div>
  {/if}
{/snippet}

<style>
  /* The layout box: holds the docked size in flow, even while the pane is
     fullscreen. */
  .preview-dock {
    display: flex;
    flex-shrink: 0;
    min-width: 0;
    min-height: 0;
  }

  /* Vertical docks fill the column width. Their height yields to the
     column's available-space cap without changing the preferred size. */
  .preview-dock.vertical {
    flex-direction: column;
    width: 100%;
    flex-shrink: 1;
  }

  .preview-pane {
    display: flex;
    flex-direction: column;
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--layout-hairline, var(--divider));
    background: var(--layout-surface, var(--background-card-secondary));
    overflow: hidden;
    /* Horizontal inset of the Preview chrome and info rows. Plugin
       Preview-info sections inherit it so their rows line up with the host's
       (SDK: PreviewInfoContribution). */
    --preview-info-inset: 16px;
  }

  .preview-pane.resizing {
    user-select: none;
  }

  /* Vertical docks: the divider moves to the docked edge. */
  .preview-pane.vertical {
    border-left: none;
  }

  /* A vertical dock is wide and short: its name, type and metadata share one
     row, as in a bottom details pane, so the content keeps the dock's height.
     Stacked, that chrome alone exceeded the 120px minimum height and left no
     room for content (#792).
     The header column takes what the name and badge need, capped at 65% of
     the pane or everything but 16rem, whichever is larger. The metadata
     column takes the rest and ellipsizes. Neither can squeeze the other to
     nothing, however long the name or a diff's path.
     Plugin Preview-info sections get their own full-width row above the
     content, as tall as their content. The content row keeps a floor (96px,
     or 40% of a very short dock) and the sections row yields first: only
     when the dock cannot fit both does the section scroll. The sizing lives
     on the tracks, not on the item: a percentage max-height on an item in an
     auto row resolves against that row after it was sized to the item's full
     height, which clipped the section behind a scrollbar and left the
     clipped-off height as dead space above the image.
     PluginPreviewTarget renders the same chrome classes as direct children of
     this pane, so the placement rules below match them with :global — this
     component owns the dock layout for both kinds of subject. */
  .preview-pane.vertical:not(.fullscreen) {
    --preview-info-inset: 12px;
    display: grid;
    grid-template-columns: fit-content(max(65%, 100% - 16rem)) minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, max-content) minmax(min(96px, 40%), 1fr);
    grid-template-areas:
      "header info"
      "actions actions"
      "sections sections"
      "content content";
  }

  /* The name has priority over the type badge: the badge gives up width
     first, down to its first few letters, before the name truncates. */
  .preview-pane.vertical:not(.fullscreen) > :global(.preview-header) {
    grid-area: header;
    display: grid;
    grid-template-columns: minmax(0, max-content) minmax(3.5rem, 1fr);
    align-items: center;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
    padding: 8px var(--preview-info-inset);
  }

  .preview-pane.vertical:not(.fullscreen) > :global(.preview-header) :global(.preview-type-badge) {
    display: block;
    align-self: center;
    justify-self: start;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-pane.vertical:not(.fullscreen) > :global(:is(.diff-actions, .target-actions-area)) {
    grid-area: actions;
  }

  .preview-pane.vertical:not(.fullscreen) > .preview-sections {
    grid-area: sections;
    max-height: none;
    min-height: 0;
  }

  .preview-pane.vertical:not(.fullscreen) > :global(.preview-content) {
    grid-area: content;
  }

  /* Each metadata field keeps its own row beside the header. A shared
     ellipsis can hide the entire Modified field in a narrow window. */
  .preview-pane.vertical:not(.fullscreen) > :global(.preview-info) {
    grid-area: info;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    min-width: 0;
    overflow: hidden;
    padding: 8px var(--preview-info-inset);
    font-size: var(--font-size-caption);
    white-space: nowrap;
    border-top: none;
    border-bottom: 1px solid var(--divider);
  }

  .preview-pane.vertical:not(.fullscreen) > :global(.preview-info) :global(.info-row) {
    display: flex;
    gap: 8px;
    min-width: 0;
    padding: 0;
    border-bottom: none;
  }

  .preview-pane.vertical:not(.fullscreen) > :global(.preview-info) :global(.info-label) {
    flex-shrink: 0;
  }

  .preview-pane.vertical:not(.fullscreen) > :global(.preview-info) :global(.info-value) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .preview-pane.vertical:not(.fullscreen) > .preview-empty {
    grid-column: 1 / -1;
    grid-row: 1 / -1;
  }

  .preview-pane.dock-bottom {
    border-top: 1px solid var(--divider);
  }

  .preview-pane.dock-top {
    border-bottom: 1px solid var(--divider);
  }

  /* Fullscreen: cover the whole window. Only the pane leaves the layout; its
     .preview-dock keeps the docked size, so the workspace panes underneath
     neither resize nor reflow. The nested zoom cancels the root UI zoom —
     otherwise 100vw/100vh are laid out pre-zoom and render zoom× the screen
     size, pushing the image off-center and off-screen (#236). */
  .preview-pane.fullscreen {
    position: fixed;
    inset: 0;
    zoom: calc(1 / var(--app-zoom, 1));
    width: 100vw;
    height: 100vh;
    z-index: 1000;
    background: var(--background-solid, var(--background-card-secondary));
    border-left: none;
  }

  .fullscreen-exit {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 1001;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: var(--subtle-fill-secondary);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .fullscreen-exit:hover {
    background: var(--subtle-fill-tertiary);
    color: var(--text-primary);
  }

  .resize-handle {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: col-resize;
    z-index: 10;
    touch-action: none;
  }

  .resize-handle:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  /* Bottom dock: handle spans the top edge (row-resize). */
  .preview-pane.dock-bottom .resize-handle {
    left: 0;
    right: 0;
    top: 0;
    bottom: auto;
    width: auto;
    height: 4px;
    cursor: row-resize;
  }

  /* Top dock: handle spans the bottom edge (row-resize). */
  .preview-pane.dock-top .resize-handle {
    left: 0;
    right: 0;
    top: auto;
    bottom: 0;
    width: auto;
    height: 4px;
    cursor: row-resize;
  }

  .resize-handle:hover,
  .preview-pane.resizing .resize-handle {
    background: var(--accent);
    opacity: 0.6;
  }

  .preview-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 10px;
    color: var(--text-tertiary);
    font-size: var(--font-size-caption);
    padding: 32px;
    text-align: center;
  }

  .preview-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px var(--preview-info-inset) 14px;
    border-bottom: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .preview-filename {
    font-size: var(--font-size-body);
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-type-badge {
    display: inline-flex;
    align-self: flex-start;
    font-size: 10px;
    line-height: 1;
    color: var(--accent-text, var(--accent));
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    padding: 3px 8px;
    border-radius: var(--radius-pill);
    letter-spacing: 0.03em;
    text-transform: uppercase;
    font-weight: 500;
  }

  .preview-content {
    position: relative;
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .video-preview-marker {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
    line-height: 0;
    pointer-events: none;
  }

  .preview-pane.fullscreen .video-preview-marker {
    top: 52px;
    right: 12px;
  }

  /* Fullscreen: image fills the whole screen symmetrically — hide the header,
     info bar and plugin Preview-info sections (which took space from the
     image). PreviewImageSurface drops its padding and rounded corners. */
  .preview-pane.fullscreen .preview-header,
  .preview-pane.fullscreen .preview-info,
  .preview-pane.fullscreen .preview-sections {
    display: none;
  }
  .preview-pane.fullscreen .preview-content {
    overflow: hidden;
  }
  /* Fullscreen text (#1039). The pane cancels the root UI zoom so images fit
     the screen, which would also shrink the text below its docked size; zoom
     the text back by the app zoom, times the wheel zoom. The wheel zoom is
     the only scroll gesture, so the content scrolls by key or scrollbar. */
  .preview-pane.fullscreen .preview-content.fs-text {
    overflow-x: hidden;
    overflow-y: auto;
  }
  .preview-pane.fullscreen .preview-content.fs-text > :global(:is(.preview-text, .preview-markdown)) {
    zoom: calc(var(--app-zoom, 1) * var(--fs-text-zoom, 1));
  }
  .preview-pane.fullscreen .preview-content.fs-text > .preview-truncated {
    zoom: var(--app-zoom, 1);
  }
  .fs-text-zoom-indicator {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1;
    padding: 4px 12px;
    border-radius: var(--radius-pill, 999px);
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  /* PluginPreviewTarget renders its chrome as direct children of this pane
     (see the dock layout above); fullscreen hides it like the file chrome. */
  .preview-pane.fullscreen > :global(:is(.preview-header, .preview-info, .target-actions-area)) {
    display: none;
  }
  .preview-pane.fullscreen > :global(.target-content) {
    overflow: hidden;
  }

  /* Hide the window tab bar / title bar while a preview is fullscreen. It
     keeps its box: removing it would move the workspace panes up under the
     fullscreen surface. */
  :global(html[data-preview-fullscreen] .titlebar) {
    visibility: hidden !important;
  }

  .preview-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 24px;
  }

  /* A slow next image: the previous one stays, with the spinner over it. */
  .preview-loading-over-image {
    position: absolute;
    inset: 0;
    padding: 0;
    pointer-events: none;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 1.5px solid var(--divider);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 600ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .image-preview-note { position: absolute; bottom: 8px; left: 8px; right: 8px; margin: 0; padding: 4px 8px; background: var(--background-solid); color: var(--text-secondary); font-size: var(--font-size-caption); pointer-events: none; }

  .preview-truncated {
    padding: 8px 16px;
    font-size: 10px;
    color: var(--text-tertiary);
    text-align: center;
    border-top: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .preview-error-text {
    color: var(--system-critical-text, var(--system-critical));
    font-size: var(--font-size-caption);
  }

  /* Stacked (side dock) layout: the sections region has a size derived from
     the pane alone, never from what the sections contain, so the content
     above it (the image) keeps the same box while the selection steps through
     files whose Preview info differs in height. Longer info scrolls in here.
     Vertical docks place it on a grid track instead (see above). */
  .preview-sections {
    flex: 0 1 min(40%, 24rem);
    min-height: 0;
    overflow: auto;
    border-top: 1px solid var(--divider);
  }

  .preview-section-error {
    margin: 8px var(--preview-info-inset);
    font-size: var(--font-size-caption);
    color: var(--text-tertiary);
  }

  .preview-info {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0;
    border-top: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-caption);
    padding: 8px var(--preview-info-inset);
    border-bottom: 1px solid var(--divider);
  }

  .info-row:last-child {
    border-bottom: none;
  }

  .info-label {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .info-value {
    color: var(--text-secondary);
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

</style>
