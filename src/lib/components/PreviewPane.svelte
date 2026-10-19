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
import { gitDiff } from "$lib/api/git";
import { openFile } from "$lib/api/open";
  import { toastStore } from "$lib/state/toast.svelte";
  import { getFileType, formatDate } from "$lib/domain/file-types";
  import VideoIndicator from "./VideoIndicator.svelte";
  import { formatResolution, formatSize, isSystemHidden, type FileEntry } from "$lib/domain/file";
  import { highlightDiffLine } from "$lib/domain/syntax-highlight";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { frecencyStore } from "$lib/state/frecency.svelte";
  import { getScmStore } from "$lib/state/scm.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { createPreviewDiffActions, type HunkAction } from "$lib/state/preview-diff-actions";
  import { gitCommitFileDiff, gitCompareCommitFileDiff } from "$lib/api/git-log";
  import VirtualList from "./VirtualList.svelte";
  import { type CsvPreview } from "$lib/domain/csv-preview";
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
  import { parseUnifiedDiff, type ParsedDiff, type DiffLine } from "$lib/domain/diff";
  import PreviewFolderList from "./PreviewFolderList.svelte";
  import PluginPreviewTarget from "./PluginPreviewTarget.svelte";
  import { previewInfoRegistry, type PreviewSubject } from "$lib/plugins/preview-registry.svelte";
  /** Detect if the current theme uses a light color scheme.
   * Recomputed via a MutationObserver on the documentElement's `data-theme`
   * attribute (set by theme.svelte.ts) — getComputedStyle only reflects the
   * new theme after the attribute has actually been applied to the DOM. */
  let isLightTheme = $state(false);
  $effect(() => {
    const compute = () =>
      (isLightTheme = getComputedStyle(document.documentElement).colorScheme === "light");
    compute();
    const observer = new MutationObserver(compute);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  });

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

  function csvRowHeight(row: string[]): number {
    return Math.max(28, 12 + Math.max(...row.map((cell) => cell.split("\n").length)) * 16);
  }

  /** One column template shared by the sticky header and every virtual row. */
  function csvColumnTemplate(csv: CsvPreview): string {
    return csv.header
      .map((header, column) => {
        const longestCell = Math.max(header.length, ...csv.rows.map((row) => row[column]?.length ?? 0));
        // Pixels keep a track's computed width identical in the bold header
        // and normal-weight data rows; `ch` varies with font weight.
        return `${Math.max(128, longestCell * 8 + 20)}px`;
      })
      .join(" ");
  }

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
  const diffPath = $derived(commitDiff?.path ?? activeDiff?.path ?? "");
  let diffParsed = $state<ParsedDiff | null>(null);
  let diffLoading = $state(false);
  let diffError = $state<string | null>(null);
  let diffRequestGen = 0;

  const diffVisibleLines = $derived.by<DiffLine[]>(() => {
    if (!diffParsed) return [];
    return diffParsed.lines.filter((l) => l.kind !== "header" && l.kind !== "meta");
  });

  const diffSubtitle = $derived.by(() => {
    if (!diffParsed) return "";
    if (diffParsed.added) return "added";
    if (diffParsed.deleted) return "deleted";
    if (diffParsed.oldPath && diffParsed.newPath && diffParsed.oldPath !== diffParsed.newPath) {
      return `renamed from ${diffParsed.oldPath}`;
    }
    return activeDiff?.staged ? "staged" : "unstaged";
  });

  // Diff header actions — restore the stage / unstage / discard / open-file
  // affordances directly on the diff so a file can be staged from its diff
  // (VSCode parity). Operates on the currently-open diff target.
  // Admission is against the pane owning the diff, shared with command routing.
  let ownershipRevision = $state(0);
  $effect(() => dialogStore.subscribeOwnership(() => { ownershipRevision++; }));
  const diffActions = createPreviewDiffActions({
    scm: () => scmStore,
    ownerPaneId: () => windowTabsManager.activePaneId,
    isPaneBlocked: (id) => dialogStore.isPaneBlocked(id),
    onError: (message) => toastStore.error(message),
    confirm: (message) => window.confirm(message),
  });
  const diffActionsBlocked = $derived.by(() => {
    void ownershipRevision;
    return diffActions.blocked();
  });
  const stageFromDiff = () => diffActions.stage();
  const unstageFromDiff = () => diffActions.unstage();
  const discardFromDiff = () => diffActions.discard();
  const applyHunk = (patch: string, action: HunkAction) => diffActions.applyHunk(patch, action);
  async function openDiffFileInEditor(): Promise<void> {
    if (!activeDiff || !scmStore.repoRoot) return;
    const abs = `${scmStore.repoRoot.replace(/\/$/, "")}/${activeDiff.path}`;
    await openFile(abs);
  }

  $effect(() => {
    if (commitDiff) {
      void loadCommitDiff(commitDiff);
      return;
    }
    if (!activeDiff || !scmStore.repoRoot) {
      diffRequestGen++; // invalidate any in-flight request
      diffInFlight = null;
      diffRenderedTarget = null;
      diffParsed = null;
      diffError = null;
      diffLoading = false;
      return;
    }
    // Depend on the summary object itself (replaced wholesale on refresh) —
    // counts can stay identical while file contents change, so a count-based
    // key would miss content updates.
    void scmStore.summary;
    loadDiff(scmStore.repoRoot, activeDiff.path, activeDiff.staged);
  });

  /** Load a commit file diff for the graph-routed target (#366). */
  async function loadCommitDiff(cd: { repoPath: string; oid: string; path: string; baseOid?: string }): Promise<void> {
    const gen = ++diffRequestGen;
    // `diffParsed` is about to hold a COMMIT diff — the working-tree render
    // cache must not claim it, or reopening that target would briefly show
    // the commit's hunks under a working-tree badge.
    diffRenderedTarget = null;
    diffInFlight = null;
    diffLoading = true;
    diffError = null;
    try {
      const text = cd.baseOid
        ? await gitCompareCommitFileDiff(cd.repoPath, cd.baseOid, cd.oid, cd.path)
        : await gitCommitFileDiff(cd.repoPath, cd.oid, cd.path);
      if (gen !== diffRequestGen || scmStore.commitDiff !== cd) return;
      diffParsed = parseUnifiedDiff(text);
    } catch (err) {
      if (gen !== diffRequestGen) return;
      diffError = err instanceof Error ? err.message : String(err);
      diffParsed = null;
    } finally {
      if (gen === diffRequestGen) diffLoading = false;
    }
  }

  // The target currently being fetched, and the one `diffParsed` belongs to,
  // both as `${repoRoot}|${path}|${staged}` (repo included: the pane and
  // sidebar stores can sit on different repos that share a relative path).
  let diffInFlight: string | null = null;
  let diffRenderedTarget: string | null = null;

  async function loadDiff(repoRoot: string, path: string, staged: boolean): Promise<void> {
    const target = `${repoRoot}|${path}|${staged}`;
    // A repo on a UNC path is polled every 3s (#387), and each poll replaces
    // `summary` — which this effect depends on — so a re-run would supersede
    // the request already fetching this same target. Over a slow share the diff
    // then never lands: the pane flashes a spinner forever and settles empty
    // (#396). A redundant reload of a target we're already loading is dropped.
    if (diffInFlight === target) return;
    diffInFlight = target;
    const gen = ++diffRequestGen;
    // Re-checking the diff we're already showing must not blank it — that's the
    // flash. A different target must, or the old file's diff would linger under
    // the new file's header.
    if (diffRenderedTarget !== target) {
      diffParsed = null;
      diffLoading = true;
    }
    diffError = null;
    try {
      const r = await gitDiff(repoRoot, path, { staged });
      // Drop stale responses: a newer request superseded this one, or the
      // target (path OR staged flag) changed while we were fetching.
      if (gen !== diffRequestGen) return;
      const current = scmStore.activeDiff;
      if (!current || current.path !== path || current.staged !== staged) return;
      if (!r.ok) {
        diffError = r.error;
        diffParsed = null;
        diffRenderedTarget = null;
      } else {
        diffParsed = parseUnifiedDiff(r.data);
        diffRenderedTarget = target;
      }
      diffLoading = false;
    } finally {
      // Always release the target, and never leave a superseded request's
      // spinner up: the winning request owns `diffLoading` from here.
      if (diffInFlight === target) diffInFlight = null;
      if (gen === diffRequestGen) diffLoading = false;
    }
  }

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
    <div class="preview-header">
      <span class="preview-filename" title={diffPath}>{diffPath.split("/").pop()}</span>
      {#if commitDiff}
        <span class="preview-type-badge diff-commit" title={commitDiff.baseOid ? `${commitDiff.baseOid} → ${commitDiff.oid}` : commitDiff.oid}>
          {commitDiff.baseOid ? `compare ${commitDiff.baseOid.slice(0, 7)} → ${commitDiff.oid.slice(0, 7)}` : `commit ${commitDiff.oid.slice(0, 7)}`}
        </span>
      {:else if activeDiff}
        <span class="preview-type-badge" class:diff-staged={activeDiff.staged} class:diff-unstaged={!activeDiff.staged}>
          {diffSubtitle || "git diff"}
        </span>
      {/if}
    </div>
    <div class="diff-actions">
      {#if commitDiff}
        <!-- Historical diff: stage/unstage/discard don't apply (#366). -->
        <button type="button" class="diff-action-btn" title="Close diff (Esc)" onclick={() => scmStore.closeCommitDiff()}>Close</button>
      {:else if activeDiff}
        <button type="button" class="diff-action-btn" disabled={diffActionsBlocked} onclick={openDiffFileInEditor}>Open File</button>
        {#if activeDiff.staged}
          <button type="button" class="diff-action-btn" disabled={diffActionsBlocked} onclick={unstageFromDiff}>Unstage</button>
        {:else}
          <button type="button" class="diff-action-btn" disabled={diffActionsBlocked} onclick={stageFromDiff}>Stage</button>
          {#if !diffParsed?.added}
            <button type="button" class="diff-action-btn danger" disabled={diffActionsBlocked} onclick={discardFromDiff}>Discard</button>
          {/if}
        {/if}
        <button type="button" class="diff-action-btn" title="Close diff (Esc)" onclick={() => scmStore.closeDiff()}>Close</button>
      {/if}
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a scrollable region must be keyboard-focusable (WCAG 2.1.1, #797). -->
    <div class="preview-content" role="region" aria-label="Diff of {diffPath}" tabindex="0">
      {#if diffLoading}
        <div class="preview-loading"><div class="spinner"></div></div>
      {:else if diffError}
        <div class="preview-empty"><span class="preview-error-text">{diffError}</span></div>
      {:else if diffParsed?.binary}
        <div class="preview-empty"><span>Binary file changed</span></div>
      {:else if diffVisibleLines.length === 0}
        <div class="preview-empty"><span>No changes to display</span></div>
      {:else}
        <div class="diff-lines">
          {#each diffVisibleLines as line (line.index)}
            <div class="diff-line {line.kind}" data-line-kind={line.kind}>
              <span class="diff-gutter old">{line.oldLine ?? ""}</span>
              <span class="diff-gutter new">{line.newLine ?? ""}</span>
              <span class="diff-sigil">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : line.kind === "hunk" ? "@" : " "}</span>
              {#if line.kind === "hunk"}
                {@const hunk = diffParsed?.hunks.find((candidate) => candidate.lineIndex === line.index)}
                <span class="diff-content hunk-content">
                  <span class="hunk-range">{line.text}</span>
                  {#if activeDiff && hunk}
                    <span class="hunk-actions">
                      {#if activeDiff.staged}
                        <button type="button" class="hunk-action" disabled={diffActionsBlocked} onclick={() => applyHunk(hunk.patch, "unstage")}>Unstage hunk</button>
                      {:else}
                        <button type="button" class="hunk-action" disabled={diffActionsBlocked} onclick={() => applyHunk(hunk.patch, "stage")}>Stage hunk</button>
                        {#if !diffParsed?.added}
                          <button type="button" class="hunk-action danger" disabled={diffActionsBlocked} onclick={() => applyHunk(hunk.patch, "discard")}>Discard hunk</button>
                        {/if}
                      {/if}
                    </span>
                  {/if}
                </span>
              {:else if line.kind === "meta" || line.kind === "header"}
                <span class="diff-content">{line.text}</span>
              {:else}
                <!-- highlightDiffLine output is hljs-generated/escaped HTML — safe sink (#227). -->
                <span class="diff-content">{@html highlightDiffLine(line.text, diffPath)}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <div class="preview-info">
      <div class="info-row">
        <span class="info-label">Path</span>
        <span class="info-value" title={diffPath}>{diffPath}</span>
      </div>
    </div>
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
        <div class="preview-csv" role="table" aria-label="CSV preview">
          <div class="preview-csv-table" style={`--csv-column-template: ${csvColumnTemplate(content.csv)};`}>
            <div class="preview-csv-row preview-csv-header" role="row">
              {#each content.csv.header as cell, index (index)}
                <div class="preview-csv-cell" role="columnheader">{cell}</div>
              {/each}
            </div>
            <VirtualList items={content.csv.rows} itemHeight={28} getItemHeight={csvRowHeight} getKey={(_row, index) => index} itemOverflow="visible" class="preview-csv-rows">
              {#snippet children(row)}
                <div class="preview-csv-row" role="row">
                  {#each row as cell, index (index)}
                    <div class="preview-csv-cell" role="cell">{cell}</div>
                  {/each}
                </div>
              {/snippet}
            </VirtualList>
          </div>
        </div>
      {:else if content.kind === "markdown"}
        <div class="preview-markdown" class:hljs-light={isLightTheme} class:hljs-dark={!isLightTheme}>{@html content.html}</div>
      {:else if content.kind === "code"}
        <pre class="preview-text preview-code" class:hljs-light={isLightTheme} class:hljs-dark={!isLightTheme}><code class="hljs">{@html content.html}</code></pre>
      {:else if content.kind === "text"}
        <pre class="preview-text">{content.text}</pre>
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
    border-left: 1px solid var(--divider);
    background: var(--background-card-secondary);
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
  .preview-pane.fullscreen .preview-content.fs-text > :is(.preview-text, .preview-markdown) {
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

  .preview-text {
    padding: 16px;
    font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
    font-size: var(--preview-font-size, 12px);
    line-height: 1.6;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    flex: 1;
  }

  .preview-code code {
    font-family: inherit;
  }

  .preview-csv {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    font-size: var(--preview-font-size, 12px);
    color: var(--text-secondary);
  }

  .preview-csv-table {
    display: flex;
    flex: 1;
    flex-direction: column;
    width: max-content;
    min-width: 100%;
    min-height: 0;
  }

  .preview-csv-row {
    display: grid;
    grid-template-columns: var(--csv-column-template);
  }

  .preview-csv-header {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--background-solid);
    border-bottom: 1px solid var(--divider);
    font-weight: 600;
  }

  .preview-csv-cell {
    min-width: 0;
    padding: 6px 10px;
    border-right: 1px solid var(--divider);
    border-bottom: 1px solid color-mix(in srgb, var(--divider) 65%, transparent);
    white-space: pre;
    line-height: 16px;
  }

  .preview-csv-rows {
    min-height: 0;
  }

  .preview-csv-table :global(.preview-csv-rows) {
    overflow-x: visible;
  }

  .preview-code :global(.hljs) {
    background: transparent;
    padding: 0;
  }

  .preview-truncated {
    padding: 8px 16px;
    font-size: 10px;
    color: var(--text-tertiary);
    text-align: center;
    border-top: 1px solid var(--divider);
    flex-shrink: 0;
  }

  /* Rendered markdown (Obsidian-style). Content comes from {@html}, so
     descendants need :global. */
  .preview-markdown {
    padding: 16px;
    font-size: var(--preview-font-size, 12px);
    line-height: 1.65;
    color: var(--text-secondary);
    flex: 1;
    overflow-wrap: break-word;
    container: preview-markdown / inline-size;
  }

  .preview-markdown :global(h1),
  .preview-markdown :global(h2),
  .preview-markdown :global(h3),
  .preview-markdown :global(h4),
  .preview-markdown :global(h5),
  .preview-markdown :global(h6) {
    color: var(--accent-light);
    font-weight: 600;
    line-height: 1.3;
    margin: 14px 0 6px;
  }

  .preview-markdown :global(h1) { font-size: 1.416667em; padding-bottom: 4px; border-bottom: 1px solid var(--divider); }
  .preview-markdown :global(h2) { font-size: 1.25em; padding-bottom: 3px; border-bottom: 1px solid var(--divider); }
  .preview-markdown :global(h3) { font-size: 1.083333em; }
  .preview-markdown :global(h4) { font-size: 1em; }

  .preview-markdown :global(h1:first-child),
  .preview-markdown :global(h2:first-child),
  .preview-markdown :global(p:first-child) {
    margin-top: 0;
  }

  .preview-markdown :global(p) {
    margin: 6px 0;
  }

  .preview-markdown :global(.md-properties) {
    margin: 0 0 14px;
    padding: 8px 10px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    background: var(--subtle-fill-secondary);
  }

  .preview-markdown :global(.md-properties dl) {
    margin: 0;
  }

  .preview-markdown :global(.md-property) {
    display: grid;
    grid-template-columns: minmax(76px, 0.38fr) minmax(0, 1fr);
    gap: 8px;
    padding: 3px 0;
  }

  /* In a narrow pane the key column would squeeze each value to a few
     characters per line; stack the key above its value instead (#792).
     Side by side needs the properties box's 22px of padding and border, the
     76px key column, the 8px gap and a 96px value: 202px. */
  @container preview-markdown (width < 202px) {
    .preview-markdown :global(.md-property) {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
    }
  }

  .preview-markdown :global(.md-property + .md-property) {
    border-top: 1px solid var(--divider);
  }

  .preview-markdown :global(.md-property-key) {
    color: var(--text-tertiary);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .preview-markdown :global(.md-property dd) {
    min-width: 0;
    margin: 0;
    color: var(--text-primary);
    overflow-wrap: anywhere;
  }

  .preview-markdown :global(.md-property-values) {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .preview-markdown :global(.md-property-values li) {
    margin: 0;
    padding: 1px 5px;
    border-radius: 999px;
    background: var(--subtle-fill-tertiary, var(--subtle-fill-secondary));
  }

  .preview-markdown :global(a) {
    color: var(--accent-text, var(--accent));
    text-decoration: none;
  }

  .preview-markdown :global(a:hover) {
    text-decoration: underline;
  }

  .preview-markdown :global(code) {
    font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
    font-size: 1em;
    background: var(--subtle-fill-secondary);
    padding: 1px 4px;
    border-radius: 3px;
  }

  .preview-markdown :global(pre.md-code) {
    background: var(--subtle-fill-secondary);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    margin: 8px 0;
    overflow-x: auto;
  }

  .preview-markdown :global(pre.md-code code) {
    background: transparent;
    padding: 0;
    white-space: pre;
  }

  .preview-markdown :global(blockquote) {
    margin: 8px 0;
    padding: 2px 12px;
    border-left: 3px solid var(--accent);
    color: var(--text-tertiary);
  }

  .preview-markdown :global(ul),
  .preview-markdown :global(ol) {
    margin: 6px 0;
    padding-left: 22px;
  }

  .preview-markdown :global(li) {
    margin: 2px 0;
  }

  .preview-markdown :global(li input[type="checkbox"]) {
    margin-right: 6px;
  }

  .preview-markdown :global(hr) {
    border: none;
    border-top: 1px solid var(--divider);
    margin: 12px 0;
  }

  .preview-markdown :global(table) {
    border-collapse: collapse;
    margin: 8px 0;
    font-size: inherit;
    display: block;
    overflow-x: auto;
  }

  .preview-markdown :global(th),
  .preview-markdown :global(td) {
    border: 1px solid var(--divider);
    padding: 4px 8px;
    text-align: left;
  }

  .preview-markdown :global(th) {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
    font-weight: 600;
  }

  /* Markdown never emits <img> (CSP img-src excludes https:, see
     domain/markdown.ts) — images degrade to this placeholder, a link for
     remote URLs or plain alt text otherwise. */
  .preview-markdown :global(.md-image-placeholder) {
    color: var(--text-tertiary);
    font-style: italic;
  }

  /* hljs token colors are shared app-wide in themes/syntax.css (#246);
     the .hljs-dark/.hljs-light scheme class lives on <html>. */

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

  /* --- Git diff styles --- */
  .preview-type-badge.diff-staged {
    background: color-mix(in srgb, #22c55e 20%, transparent);
    color: #16a34a;
  }

  .preview-type-badge.diff-unstaged {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent-text, var(--accent));
  }

  .diff-actions {
    display: flex;
    gap: 6px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--divider);
    flex-wrap: wrap;
  }

  .diff-action-btn {
    padding: 3px 10px;
    background: transparent;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }

  .diff-action-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .diff-action-btn.danger:hover {
    color: var(--system-critical-text, var(--system-critical, #dc2626));
    border-color: var(--system-critical, #dc2626);
  }

  .diff-lines {
    flex: 1;
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 18px;
  }

  .diff-line {
    display: grid;
    grid-template-columns: 36px 36px 14px 1fr;
    min-height: 18px;
    white-space: pre;
    padding-right: 8px;
  }

  .diff-line.context { background: transparent; }
  .diff-line.add { background: color-mix(in srgb, #22c55e 12%, transparent); }
  .diff-line.remove { background: color-mix(in srgb, #ef4444 14%, transparent); }
  .diff-line.hunk { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--text-tertiary); }
  .diff-line.binary { color: var(--text-tertiary); font-style: italic; }

  .diff-gutter {
    padding-right: 4px;
    text-align: right;
    color: var(--text-tertiary);
    user-select: none;
    border-right: 1px solid color-mix(in srgb, var(--divider) 50%, transparent);
  }

  .diff-sigil {
    text-align: center;
    color: var(--text-tertiary);
    user-select: none;
  }

  .diff-line.add .diff-sigil { color: #16a34a; }
  .diff-line.remove .diff-sigil { color: #dc2626; }

  .diff-content {
    padding-left: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: text;
  }

  .hunk-content, .hunk-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* In a narrow pane a hunk's actions wrap below its range, the range
     ellipsizes, and each action's label wraps, so no action is ever clipped
     out of reach (#792). */
  .hunk-content {
    flex-wrap: wrap;
    row-gap: 2px;
  }

  .hunk-range {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hunk-actions {
    flex: 1 0 100%;
    flex-wrap: wrap;
    min-width: 0;
    max-width: 100%;
  }

  .hunk-action {
    min-width: 0;
    max-width: 100%;
    padding: 1px 3px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    background: var(--background-card);
    color: var(--text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 10px;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .hunk-action.danger { color: var(--system-critical-text, var(--system-critical, #dc2626)); }

  /* Vibrancy: own island, no left border needed */
  :global([data-vibrancy]) .preview-pane {
    background: transparent;
    border-left: none;
  }

  /* …but the fullscreen surface must stay opaque (#391). The rule above has
     the same specificity as `.preview-pane.fullscreen` and is declared later,
     so in every island mode (macOS vibrancy, Windows Mica/Acrylic,
     floatingIslands) it stripped the fullscreen background — the app behind
     the image kept showing through, reading as a second preview. */
  :global([data-vibrancy]) .preview-pane.fullscreen {
    background: var(--background-solid, var(--background-card-secondary));
  }
</style>
