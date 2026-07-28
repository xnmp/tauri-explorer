<!--
  PreviewPane component - File preview panel
  Issue: tauri-explorer-2c6b, tauri-explorer-xago, tauri-explorer-osjq
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { readTextFile, fetchDirectory, gitDiff, listArchiveContents, readImageAsBlobUrl, openFile } from "$lib/api/files";
  import { toastStore } from "$lib/state/toast.svelte";
  import { isImageFile, isSvgFile, isTextFile, isPdfFile, isZipFile, getFileType, formatDate } from "$lib/domain/file-types";
  import { formatSize, isSystemHidden, type FileEntry } from "$lib/domain/file";
  import { isTauri } from "$lib/api/mock-invoke";
  import { highlightCode, highlightDiffLine } from "$lib/domain/syntax-highlight";
  import { renderMarkdown } from "$lib/domain/markdown";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { frecencyStore } from "$lib/state/frecency.svelte";
  import { getFileIconColor } from "$lib/domain/file-types";
  import { getScmStore } from "$lib/state/scm.svelte";
  import { gitCommitFileDiff } from "$lib/api/git-log";
  import { logFrontendDiagnostic } from "$lib/api/frontend-log";

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
  import FileIcon from "./FileIcon.svelte";
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

  // Resize handle state
  const DEFAULT_WIDTH = 280;
  const MIN_WIDTH = 160;
  const MAX_WIDTH = 600;
  const DEFAULT_HEIGHT = 240;
  const MIN_HEIGHT = 120;
  const MAX_HEIGHT = 600;
  let resizing = $state(false);
  let startX = 0;
  let startY = 0;
  let startWidth = 0;
  let startHeight = 0;

  const paneWidth = $derived(settingsStore.previewPaneWidth || DEFAULT_WIDTH);
  const paneHeight = $derived(settingsStore.previewPaneHeight || DEFAULT_HEIGHT);
  // Dock edge — resolved concrete edge (settingsStore already resolves "auto"
  // via window size, #467), read directly like other settings this consumes.
  const position = $derived(settingsStore.resolvedPreviewPanePosition);
  const isVertical = $derived(position === "top" || position === "bottom");

  // --- Fullscreen preview (double-click to toggle, Esc to exit) ---
  // The image fits the screen (object-fit: contain). Zoom with +/- or Ctrl+wheel;
  // when zoomed, arrows pan. At base zoom, Left/Right step to the previous/next
  // previewable sibling file. The window tab bar hides while fullscreen.
  let fullscreen = $state(false);
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 8;
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);

  const imageTransform = $derived(
    fullscreen && zoom !== 1
      ? `translate(${panX}px, ${panY}px) scale(${zoom})`
      : fullscreen
        ? "scale(1)"
        : "",
  );

  function resetZoom(): void {
    zoom = 1;
    panX = 0;
    panY = 0;
  }

  function setZoom(next: number): void {
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    if (zoom === 1) {
      panX = 0;
      panY = 0;
    }
  }

  function toggleFullscreen(): void {
    fullscreen = !fullscreen;
    resetZoom();
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
    resetZoom();
  }

  /** Zoom keeping the image point under the cursor fixed (standard image-
   *  viewer behavior). The transform is `translate(pan) scale(zoom)` around
   *  the container center, so for a cursor at offset c from that center the
   *  point stays put when pan' = c - (c - pan) * zoom'/zoom. */
  let imageContainerEl = $state<HTMLElement | null>(null);

  function zoomAtPoint(next: number, clientX: number, clientY: number): void {
    const prev = zoom;
    setZoom(next);
    if (zoom === prev || zoom === 1 || !imageContainerEl) return;
    const rect = imageContainerEl.getBoundingClientRect();
    const cx = clientX - (rect.left + rect.width / 2);
    const cy = clientY - (rect.top + rect.height / 2);
    panX = cx - ((cx - panX) * zoom) / prev;
    panY = cy - ((cy - panY) * zoom) / prev;
  }

  function handleFullscreenWheel(event: WheelEvent): void {
    if (!fullscreen) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomAtPoint(zoom * factor, event.clientX, event.clientY);
  }

  // --- Drag-to-pan while zoomed (#236) ---
  let panning = $state(false);
  let panMoved = false;
  let lastPointerX = 0;
  let lastPointerY = 0;

  function handleImagePointerDown(event: PointerEvent): void {
    if (!fullscreen || zoom <= 1 || event.button !== 0) return;
    panning = true;
    panMoved = false;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Pointer already released (or synthetic event) — pan still works, the
      // capture is just a nicety for drags that leave the container.
    }
  }

  function handleImagePointerMove(event: PointerEvent): void {
    if (!panning) return;
    const dx = event.clientX - lastPointerX;
    const dy = event.clientY - lastPointerY;
    if (Math.abs(dx) + Math.abs(dy) > 2) panMoved = true;
    panX += dx;
    panY += dy;
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
  }

  function handleImagePointerUp(): void {
    panning = false;
  }

  /** Click toggles fullscreen only for a clean click at fit zoom — a drag
   *  release or a click while zoomed must not exit. */
  function handleImageClick(event: MouseEvent): void {
    event.stopPropagation();
    if (panMoved) {
      panMoved = false;
      return;
    }
    if (fullscreen && zoom > 1) return;
    toggleFullscreen();
  }

  // While fullscreen: Esc exits; +/- and 0 zoom; arrows pan when zoomed,
  // else step between sibling files. Capture phase + stopImmediatePropagation
  // so this wins over the global keyboard handler in +page.svelte.
  $effect(() => {
    if (!fullscreen) return;
    const PAN = 60;
    const onKey = (event: KeyboardEvent) => {
      const k = event.key;
      const stop = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (k === "Escape") {
        stop();
        fullscreen = false;
        resetZoom();
      } else if (k === "+" || k === "=") {
        stop();
        setZoom(zoom * 1.25);
      } else if (k === "-" || k === "_") {
        stop();
        setZoom(zoom / 1.25);
      } else if (k === "0") {
        stop();
        resetZoom();
      } else if (k === "ArrowLeft") {
        stop();
        if (zoom > 1) panX += PAN;
        else navigateSibling(-1);
      } else if (k === "ArrowRight") {
        stop();
        if (zoom > 1) panX -= PAN;
        else navigateSibling(1);
      } else if (k === "ArrowUp" && zoom > 1) {
        stop();
        panY += PAN;
      } else if (k === "ArrowDown" && zoom > 1) {
        stop();
        panY -= PAN;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  // Hide the window tab bar (and other chrome) while a preview is fullscreen,
  // via a document attribute that global CSS keys off (the tab bar lives far up
  // the tree, outside this component).
  $effect(() => {
    if (fullscreen) {
      document.documentElement.setAttribute("data-preview-fullscreen", "");
      return () => document.documentElement.removeAttribute("data-preview-fullscreen");
    }
  });

  function handleResizeStart(event: MouseEvent): void {
    event.preventDefault();
    resizing = true;
    startX = event.clientX;
    startY = event.clientY;
    startWidth = paneWidth;
    startHeight = paneHeight;
    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeEnd);
  }

  function handleResizeMove(event: MouseEvent): void {
    if (isVertical) {
      // Bottom dock: handle on the top edge, dragging up grows the pane.
      // Top dock: handle on the bottom edge, dragging down grows the pane.
      const delta = position === "bottom" ? startY - event.clientY : event.clientY - startY;
      const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + delta));
      settingsStore.setPreviewPaneHeight(newHeight);
    } else {
      // Right dock: handle on the left edge, dragging left grows the pane.
      const delta = startX - event.clientX;
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta));
      settingsStore.setPreviewPaneWidth(newWidth);
    }
  }

  function handleResizeEnd(): void {
    resizing = false;
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeEnd);
  }

  /** Currently selected file from the active explorer */
  const selectedFile = $derived.by((): FileEntry | null => {
    const explorer = windowTabsManager.getActiveExplorer();
    if (!explorer) return null;
    const selected = explorer.getSelectedEntries();
    return selected.length === 1 ? selected[0] : null;
  });

  /** Stable primitive that changes when the selected path OR its mtime changes,
   * so external edits to the same file invalidate the cached preview. */
  const selectedPath = $derived(selectedFile?.path ?? null);
  const previewKey = $derived(
    selectedFile ? `${selectedFile.path}|${selectedFile.modified}|${selectedFile.size}` : null,
  );

  // Preview content state
  let previewImageUrl = $state<string | null>(null);
  let previewText = $state<string | null>(null);
  let previewHighlightedHtml = $state<string | null>(null);
  let previewMarkdownHtml = $state<string | null>(null);
  let previewPdfUrl = $state<string | null>(null);
  let previewFolderChildrenRaw = $state<readonly FileEntry[]>([]);
  // Set when a folder/ZIP preview descended through one or more single-child
  // folders: the collapsed path (e.g. "a/b") and a short note describing it.
  let previewCollapsedRoot = $state<string | null>(null);
  let previewCollapsedNote = $state<string | null>(null);
  const previewFolderChildren = $derived(
    settingsStore.showHidden
      ? previewFolderChildrenRaw
      : previewFolderChildrenRaw.filter((e) => !e.name.startsWith(".") && !isSystemHidden(e.name))
  );
  let previewLoading = $state(false);
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
  let previewError = $state<string | null>(null);
  let previewTruncatedLines = $state(0);
  let lastPreviewPath: string | null = null;
  let lastPreviewKey: string | null = null;

  // --- Git diff preview state ---
  const activeDiff = $derived(scmStore.activeDiff);
  // Commit file diff routed from the git graph (#366); wins over the
  // working-tree diff when both are somehow set (openers clear the other).
  const commitDiff = $derived(scmStore.commitDiff);
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
  async function stageFromDiff(): Promise<void> {
    if (!activeDiff) return;
    const path = activeDiff.path;
    await scmStore.stage([path]);
    // Follow the file to its staged diff so the view doesn't leave the user
    // staring at an empty "unstaged" diff after the change moved to the index.
    if (scmStore.summary.staged.some((e) => e.path === path)) {
      scmStore.openDiff(path, true);
    }
  }
  async function unstageFromDiff(): Promise<void> {
    if (!activeDiff) return;
    const path = activeDiff.path;
    await scmStore.unstage([path]);
    // Follow the file back to its worktree diff if it still has changes there.
    const stillChanged =
      scmStore.summary.changes.some((e) => e.path === path) ||
      scmStore.summary.untracked.some((e) => e.path === path);
    if (stillChanged) scmStore.openDiff(path, false);
  }
  async function discardFromDiff(): Promise<void> {
    if (!activeDiff) return;
    const r = await scmStore.discard([activeDiff.path]);
    if (!r.ok) {
      toastStore.error(`Discard failed: ${r.error}`);
      return;
    }
    scmStore.closeDiff();
  }
  async function applyHunk(patch: string, action: "stage" | "unstage" | "discard"): Promise<void> {
    if (!activeDiff) return;
    if (action === "discard" && !window.confirm("Discard this hunk? This cannot be undone.")) return;
    const path = activeDiff.path;
    const r = await scmStore.applyPatch(patch, action);
    if (!r.ok) {
      toastStore.error(`${action[0].toUpperCase()}${action.slice(1)} hunk failed: ${r.error}`);
      return;
    }
    const stillStaged = scmStore.summary.staged.some((entry) => entry.path === path);
    const stillUnstaged = scmStore.summary.changes.some((entry) => entry.path === path);
    // A partially changed file can exist in both buckets. Only switch the
    // displayed side when the operation exhausted the current side.
    if (action === "stage" && !stillUnstaged && stillStaged) scmStore.openDiff(path, true);
    if (action === "unstage" && !stillStaged && stillUnstaged) scmStore.openDiff(path, false);
    if (action === "discard" && !stillUnstaged) scmStore.closeDiff();
  }
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
  async function loadCommitDiff(cd: { repoPath: string; oid: string; path: string }): Promise<void> {
    const gen = ++diffRequestGen;
    // `diffParsed` is about to hold a COMMIT diff — the working-tree render
    // cache must not claim it, or reopening that target would briefly show
    // the commit's hunks under a working-tree badge.
    diffRenderedTarget = null;
    diffInFlight = null;
    diffLoading = true;
    diffError = null;
    try {
      const text = await gitCommitFileDiff(cd.repoPath, cd.oid, cd.path);
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
      lastPreviewPath = null;
      lastPreviewKey = null;
      previewImageUrl = null;
      previewText = null;
      previewHighlightedHtml = null;
      previewMarkdownHtml = null;
      previewPdfUrl = null;
      previewFolderChildrenRaw = [];
      previewCollapsedRoot = null;
      previewCollapsedNote = null;
      previewError = null;
      previewLoading = false;
      return;
    }
    if (key === lastPreviewKey) return;
    lastPreviewPath = path;
    lastPreviewKey = key;
    loadPreview(file);
  });

  /** Decode an image off the main thread so selection/animation aren't blocked */
  async function decodeImage(url: string): Promise<string> {
    const img = new Image();
    img.src = url;
    await img.decode();
    return url;
  }

  async function loadPreview(file: FileEntry): Promise<void> {
    // Release any object-URL from a previous backend-fallback image so the
    // bytes aren't pinned in memory across navigations.
    if (previewImageUrl?.startsWith("blob:")) URL.revokeObjectURL(previewImageUrl);
    previewImageUrl = null;
    previewText = null;
    previewHighlightedHtml = null;
    previewMarkdownHtml = null;
    previewPdfUrl = null;
    previewFolderChildrenRaw = [];
    previewCollapsedRoot = null;
    previewCollapsedNote = null;
    previewError = null;
    previewTruncatedLines = 0;
    previewLoading = true;

    if (file.kind !== "directory") {
      // Previewing a file marks its folder as actively worked-in for Recent ranking.
      frecencyStore.recordFileAction(file.path);
    }

    if (file.kind === "directory") {
      // Descend through any chain of single-child folders so the preview
      // shows useful content instead of one lonely folder, then report the
      // collapsed path (e.g. "a/b") in the indicator. Capped to guard against
      // symlink cycles.
      const MAX_DESCENT = 40;
      let dirPath = file.path;
      const chain: string[] = [];
      for (let depth = 0; depth < MAX_DESCENT; depth++) {
        const result = await fetchDirectory(dirPath);
        if (file.path !== lastPreviewPath) return;
        if (!result.ok) {
          previewError = result.error;
          previewLoading = false;
          return;
        }
        const entries = result.data.entries;
        if (entries.length === 1 && entries[0].kind === "directory") {
          chain.push(entries[0].name);
          dirPath = entries[0].path;
          continue;
        }
        previewFolderChildrenRaw = entries;
        if (chain.length > 0) {
          previewCollapsedRoot = chain.join("/");
          previewCollapsedNote = chain.length === 1 ? "single subfolder" : "single-folder chain";
        }
        break;
      }
      previewLoading = false;
      return;
    }

    // ZIP files preview their contents in the same folder-list format as a
    // directory (one level deep, directories first). When the archive collapses
    // to a single top-level folder (or chain of them), descend and show its name.
    if (isZipFile(file)) {
      const result = await listArchiveContents(file.path);
      if (file.path !== lastPreviewPath) return;
      if (result.ok) {
        previewFolderChildrenRaw = result.data.entries;
        if (result.data.rootFolder) {
          previewCollapsedRoot = result.data.rootFolder;
          previewCollapsedNote = "single top-level folder";
        }
      } else {
        previewError = result.error;
      }
      previewLoading = false;
      return;
    }

    // Cache-busting suffix derived from mtime+size — same value as previewKey,
    // ensures the webview re-fetches when the on-disk file changes.
    const bust = encodeURIComponent(`${file.modified}-${file.size}`);

    if (isPdfFile(file)) {
      if (isTauri()) {
        try {
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          previewPdfUrl = `${convertFileSrc(file.path)}?v=${bust}`;
        } catch (error) {
          console.warn("[preview] PDF asset URL creation failed", { path: file.path, error });
          logFrontendDiagnostic("preview PDF asset URL creation failed", {
            path: file.path,
            error: error instanceof Error ? error.message : String(error),
          });
          previewError = "Cannot preview PDF";
        }
      } else {
        previewError = "PDF preview requires Tauri runtime";
      }
      previewLoading = false;
      return;
    }

    if (isImageFile(file) || isSvgFile(file)) {
      // Pull the bytes through the backend. Used when the asset: protocol
      // can't stream a file — notably cloud-mounted images (Google Drive,
      // OneDrive) whose placeholder paths it fails to read (the read forces
      // the cloud client to hydrate the file) — and as the only path in
      // browser/E2E mode, where the mock serves a data URI.
      const loadViaBackend = async () => {
        const fallback = await readImageAsBlobUrl(file.path);
        if (file.path !== lastPreviewPath) return; // Stale after fetch
        if (fallback.ok) {
          try {
            await decodeImage(fallback.data);
            if (file.path !== lastPreviewPath) return; // Stale after decode
            previewImageUrl = fallback.data;
          } catch (error) {
            console.warn("[preview] backend image decode failed", { path: file.path, error });
            logFrontendDiagnostic("preview backend image decode failed", {
              path: file.path,
              error: error instanceof Error ? error.message : String(error),
            });
            previewError = "Cannot preview image";
          }
        } else {
          console.warn("[preview] backend image read failed", { path: file.path, error: fallback.error });
          logFrontendDiagnostic("preview backend image read failed", {
            path: file.path,
            error: fallback.error,
          });
          previewError = "Cannot preview image";
        }
      };

      if (isTauri()) {
        try {
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          if (file.path !== lastPreviewPath) return; // Stale
          const url = `${convertFileSrc(file.path)}?v=${bust}`;
          // Decode off-screen — spinner stays visible until ready
          await decodeImage(url);
          if (file.path !== lastPreviewPath) return; // Stale after decode
          previewImageUrl = url;
        } catch (assetErr) {
          console.warn("[preview] asset image decode failed; using backend fallback", {
            path: file.path,
            error: assetErr,
          });
          logFrontendDiagnostic("preview asset image decode failed", {
            path: file.path,
            error: assetErr instanceof Error ? assetErr.message : String(assetErr),
          });
          await loadViaBackend();
        }
      } else {
        await loadViaBackend();
      }
    } else if (isTextFile(file)) {
      const result = await readTextFile(file.path, 524288); // 512KB limit for preview
      if (file.path !== lastPreviewPath) return; // Stale
      if (result.ok) {
        // Limit to first 200 lines to avoid lag on large files
        const MAX_PREVIEW_LINES = 200;
        const lines = result.data.split("\n");
        const truncated = lines.length > MAX_PREVIEW_LINES;
        const displayText = truncated
          ? lines.slice(0, MAX_PREVIEW_LINES).join("\n")
          : result.data;
        previewText = displayText;
        previewTruncatedLines = truncated ? lines.length : 0;
        const isMarkdown = /\.(md|markdown)$/i.test(file.name);
        if (isMarkdown && displayText.length < 200_000) {
          // Obsidian-style: render the markdown; fenced code blocks keep
          // syntax highlighting via the shared hljs setup.
          try {
            previewMarkdownHtml = renderMarkdown(displayText);
          } catch {
            previewMarkdownHtml = null;
          }
        }
        // Only syntax-highlight if content is reasonably small (< 50KB)
        if (displayText.length < 50_000) {
          try {
            previewHighlightedHtml = highlightCode(displayText, file.name);
          } catch {
            previewHighlightedHtml = null;
          }
        } else {
          previewHighlightedHtml = null;
        }
      } else {
        previewError = result.error;
      }
    }

    previewLoading = false;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="preview-pane"
  class:resizing
  class:fullscreen
  class:vertical={isVertical}
  class:dock-bottom={position === "bottom"}
  class:dock-top={position === "top"}
  style={isVertical
    ? `height: ${paneHeight}px; --preview-font-size: ${settingsStore.previewFontSize}px;`
    : `width: ${paneWidth}px; --preview-font-size: ${settingsStore.previewFontSize}px;`}
  ondblclick={toggleFullscreen}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="resize-handle" onmousedown={handleResizeStart}></div>
  {#if fullscreen}
    <button class="fullscreen-exit" onclick={(e) => { e.stopPropagation(); fullscreen = false; }} title="Exit full screen (Esc)" aria-label="Exit full screen">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </button>
  {/if}
  {#if activeDiff || commitDiff}
    <div class="preview-header">
      <span class="preview-filename" title={diffPath}>{diffPath.split("/").pop()}</span>
      {#if commitDiff}
        <span class="preview-type-badge diff-commit" title={commitDiff.oid}>
          commit {commitDiff.oid.slice(0, 7)}
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
        <button type="button" class="diff-action-btn" onclick={openDiffFileInEditor}>Open File</button>
        {#if activeDiff.staged}
          <button type="button" class="diff-action-btn" onclick={unstageFromDiff}>Unstage</button>
        {:else}
          <button type="button" class="diff-action-btn" onclick={stageFromDiff}>Stage</button>
          {#if !diffParsed?.added}
            <button type="button" class="diff-action-btn danger" onclick={discardFromDiff}>Discard</button>
          {/if}
        {/if}
        <button type="button" class="diff-action-btn" title="Close diff (Esc)" onclick={() => scmStore.closeDiff()}>Close</button>
      {/if}
    </div>
    <div class="preview-content">
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
                  <span>{line.text}</span>
                  {#if activeDiff && hunk}
                    <span class="hunk-actions">
                      {#if activeDiff.staged}
                        <button type="button" class="hunk-action" onclick={() => applyHunk(hunk.patch, "unstage")}>Unstage hunk</button>
                      {:else}
                        <button type="button" class="hunk-action" onclick={() => applyHunk(hunk.patch, "stage")}>Stage hunk</button>
                        {#if !diffParsed?.added}
                          <button type="button" class="hunk-action danger" onclick={() => applyHunk(hunk.patch, "discard")}>Discard hunk</button>
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

    <div class="preview-content">
      {#if previewLoading}
        {#if showPreviewSpinner}
          <div class="preview-loading">
            <div class="spinner"></div>
          </div>
        {/if}
      {:else if previewPdfUrl}
        <div class="preview-pdf-container">
          <iframe src={previewPdfUrl} title={selectedFile.name} class="preview-pdf"></iframe>
        </div>
      {:else if previewImageUrl}
        <!-- Click brings the image front and center (fullscreen); clicking
             again reverts (#219). stopPropagation so the pane's dblclick
             toggle can't double-fire on the same gesture. -->
        <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
        <div
          class="preview-image-container"
          class:panning
          bind:this={imageContainerEl}
          onwheel={handleFullscreenWheel}
          onclick={handleImageClick}
          ondblclick={(e) => e.stopPropagation()}
          onpointerdown={handleImagePointerDown}
          onpointermove={handleImagePointerMove}
          onpointerup={handleImagePointerUp}
          onpointercancel={handleImagePointerUp}
        >
          <img
            src={previewImageUrl}
            alt={selectedFile.name}
            class="preview-image"
            class:zoomed={fullscreen && zoom > 1}
            style:transform={imageTransform}
            draggable="false"
          />
          {#if fullscreen}
            <div class="fs-zoom-indicator">{Math.round(zoom * 100)}%</div>
          {/if}
        </div>
      {:else if previewFolderChildren.length > 0}
        <div class="preview-folder-list">
          {#if previewCollapsedRoot}
            <div class="collapsed-root-indicator" title="Showing the contents of the only folder inside">
              <svg class="collapsed-root-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 4C2 3.45 2.45 3 3 3H6L7.5 4.5H13C13.55 4.5 14 4.95 14 5.5V12C14 12.55 13.55 13 13 13H3C2.45 13 2 12.55 2 12V4Z" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-width="1.1"/>
              </svg>
              <span class="collapsed-root-name">{previewCollapsedRoot}/</span>
              <span class="collapsed-root-note">{previewCollapsedNote}</span>
            </div>
          {/if}
          {#each previewFolderChildren as child}
            <div class="folder-item" class:is-directory={child.kind === "directory"}>
              <span class="folder-item-icon" style:color={child.kind !== "directory" ? getFileIconColor(child) : undefined}>
                <FileIcon entry={child} size="small" />
              </span>
              <span class="folder-item-name">{child.name}</span>
            </div>
          {/each}
        </div>
      {:else if previewMarkdownHtml !== null}
        <div class="preview-markdown" class:hljs-light={isLightTheme} class:hljs-dark={!isLightTheme}>{@html previewMarkdownHtml}</div>
        {#if previewTruncatedLines > 0}
          <div class="preview-truncated">Showing first 200 of {previewTruncatedLines.toLocaleString()} lines</div>
        {/if}
      {:else if previewHighlightedHtml !== null}
        <pre class="preview-text preview-code" class:hljs-light={isLightTheme} class:hljs-dark={!isLightTheme}><code class="hljs">{@html previewHighlightedHtml}</code></pre>
        {#if previewTruncatedLines > 0}
          <div class="preview-truncated">Showing first 200 of {previewTruncatedLines.toLocaleString()} lines</div>
        {/if}
      {:else if previewText !== null}
        <pre class="preview-text">{previewText}</pre>
        {#if previewTruncatedLines > 0}
          <div class="preview-truncated">Showing first 200 of {previewTruncatedLines.toLocaleString()} lines</div>
        {/if}
      {:else if previewError}
        <div class="preview-empty">
          <span class="preview-error-text">{previewError}</span>
        </div>
      {:else}
        <div class="preview-empty">
          <span>No preview available</span>
        </div>
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
        <div class="info-row">
          <span class="info-label">Modified</span>
          <span class="info-value">{formatDate(selectedFile.modified)}</span>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .preview-pane {
    display: flex;
    flex-direction: column;
    position: relative;
    flex-shrink: 0;
    border-left: 1px solid var(--divider);
    background: var(--background-card-secondary);
    overflow: hidden;
  }

  .preview-pane.resizing {
    user-select: none;
  }

  /* Vertical docks fill the column width; the divider moves to the docked edge. */
  .preview-pane.vertical {
    width: 100%;
    flex-shrink: 0;
    border-left: none;
  }

  .preview-pane.dock-bottom {
    border-top: 1px solid var(--divider);
  }

  .preview-pane.dock-top {
    border-bottom: 1px solid var(--divider);
  }

  /* Fullscreen: cover the whole window (overrides the inline width). The
     nested zoom cancels the root UI zoom — otherwise 100vw/100vh are laid out
     pre-zoom and render zoom× the screen size, pushing the image off-center
     and off-screen (#236). */
  .preview-pane.fullscreen {
    position: fixed;
    inset: 0;
    zoom: calc(1 / var(--app-zoom, 1));
    width: 100vw !important;
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
    transition: background var(--transition-normal);
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
    padding: 16px 16px 14px;
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
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    padding: 3px 8px;
    border-radius: var(--radius-pill);
    letter-spacing: 0.03em;
    text-transform: uppercase;
    font-weight: 500;
  }

  .preview-content {
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* Fullscreen: image fills the whole screen symmetrically — hide the header
     and info bar (which created an asymmetric top margin) and drop the image
     container padding and the image's rounded corners. */
  .preview-pane.fullscreen .preview-header,
  .preview-pane.fullscreen .preview-info {
    display: none;
  }
  .preview-pane.fullscreen .preview-content {
    overflow: hidden;
  }
  .preview-pane.fullscreen .preview-image-container {
    /* Fill the whole fullscreen pane and centre the image both ways,
       independent of the flex chain. */
    position: absolute;
    inset: 0;
    min-height: 0;
    overflow: hidden;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .preview-pane.fullscreen .preview-image {
    border-radius: 0;
    box-shadow: none;
  }
  .preview-pane.fullscreen .preview-image {
    transition: transform 80ms ease-out;
    cursor: zoom-in;
  }
  .preview-pane.fullscreen .preview-image.zoomed {
    cursor: grab;
    transition: none;
  }
  .preview-pane.fullscreen .preview-image-container.panning,
  .preview-pane.fullscreen .preview-image-container.panning .preview-image {
    cursor: grabbing;
  }

  /* Hide the window tab bar / title bar while a preview is fullscreen. */
  :global(html[data-preview-fullscreen] .titlebar) {
    display: none !important;
  }

  .fs-zoom-indicator {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 12px;
    border-radius: var(--radius-pill, 999px);
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  .preview-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 24px;
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

  .preview-pdf-container {
    flex: 1;
    display: flex;
  }

  .preview-pdf {
    width: 100%;
    height: 100%;
    border: none;
  }

  .preview-image-container {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 20px;
    /* Click toggles front-and-center (#219). */
    cursor: zoom-in;
    background:
      repeating-conic-gradient(
        rgba(255, 255, 255, 0.03) 0% 25%,
        transparent 0% 50%
      ) 50% / 12px 12px;
  }

  .preview-pane.fullscreen .preview-image-container {
    cursor: zoom-out;
  }

  .preview-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-card);
  }

  .preview-text {
    padding: 16px;
    font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
    font-size: var(--preview-font-size, 11px);
    line-height: 1.6;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    flex: 1;
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
  }

  .preview-markdown :global(h1),
  .preview-markdown :global(h2),
  .preview-markdown :global(h3),
  .preview-markdown :global(h4),
  .preview-markdown :global(h5),
  .preview-markdown :global(h6) {
    color: var(--text-primary);
    font-weight: 600;
    line-height: 1.3;
    margin: 14px 0 6px;
  }

  .preview-markdown :global(h1) { font-size: 17px; padding-bottom: 4px; border-bottom: 1px solid var(--divider); }
  .preview-markdown :global(h2) { font-size: 15px; padding-bottom: 3px; border-bottom: 1px solid var(--divider); }
  .preview-markdown :global(h3) { font-size: 13px; }
  .preview-markdown :global(h4) { font-size: 12px; }

  .preview-markdown :global(h1:first-child),
  .preview-markdown :global(h2:first-child),
  .preview-markdown :global(p:first-child) {
    margin-top: 0;
  }

  .preview-markdown :global(p) {
    margin: 6px 0;
  }

  .preview-markdown :global(a) {
    color: var(--accent);
    text-decoration: none;
  }

  .preview-markdown :global(a:hover) {
    text-decoration: underline;
  }

  .preview-markdown :global(code) {
    font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
    font-size: 11px;
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
    font-size: 11px;
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
    color: var(--system-critical);
    font-size: var(--font-size-caption);
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
    padding: 8px 16px;
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

  .preview-folder-list {
    flex: 1;
    overflow: auto;
    padding: 4px 0;
  }

  .collapsed-root-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 8px 6px;
    padding: 5px 8px;
    background: var(--subtle-fill-secondary);
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-secondary);
  }

  .collapsed-root-icon {
    color: var(--accent);
    flex-shrink: 0;
  }

  .collapsed-root-name {
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .collapsed-root-note {
    margin-left: auto;
    color: var(--text-tertiary);
    font-size: 11px;
    flex-shrink: 0;
  }

  .folder-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 16px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .folder-item.is-directory .folder-item-name {
    font-weight: 500;
    color: var(--text-primary);
  }

  .folder-item-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .folder-item-name {
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
    color: var(--accent);
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
    color: var(--system-critical, #dc2626);
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

  .hunk-content { justify-content: space-between; }

  .hunk-action {
    padding: 1px 5px;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    background: var(--background-card);
    color: var(--text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 10px;
  }

  .hunk-action.danger { color: var(--system-critical, #dc2626); }

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
