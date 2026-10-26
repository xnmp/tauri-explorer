<!--
  Main Explorer page - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-w3t, tauri-explorer-npjh, tauri-explorer-1ex, tauri-explorer-auj, tauri-explorer-npjh.4
-->
<script lang="ts">
  import { jobRevealController } from "$lib/state/job-reveal";
  import "@fontsource-variable/inter/index.css";
  import { onMount } from "svelte";
  import { startWindowSession } from "$lib/state/window-session";
  import { loadE2EHooks } from "$lib/api/e2e-hooks";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { applyWindowsBackdrop } from "$lib/state/window-backdrop";
  import { layoutStore } from "$lib/state/layout.svelte";
  import "$lib/layouts/floating-islands.css";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { resolveLaunchHomePath } from "$lib/state/window-title.svelte";
  import { markStartup, reportStartupReady } from "$lib/state/startup-timing";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { saveFocusedWindowState } from "$lib/state/focused-window";
  import { terminalPanelStore } from "$lib/state/terminal.svelte";
  import { setFfmpegPath } from "$lib/api/system";
  import { installTrashLocation } from "$lib/state/trash-provider";
  import "$lib/themes/index.css";
  import WindowDialogs from "$lib/components/WindowDialogs.svelte";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import CrashNotice from "$lib/components/CrashNotice.svelte";
  import UpdateNotice from "$lib/components/UpdateNotice.svelte";
  import type { PickerInfo } from "$lib/components/FilePicker.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import PaneContainer from "$lib/components/PaneContainer.svelte";
  import FileRecoveryNotice from "$lib/components/FileRecoveryNotice.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import AnimatedBackground from "$lib/components/AnimatedBackground.svelte";
  import MillerColumns from "$lib/components/MillerColumns.svelte";

  // First milestone: the app bundle has parsed and begun executing. The gap
  // from boot t0 to here is the JS download+parse cost the lazy-loading targets.
  markStartup("bundle-exec");

  // Before any tab restore can navigate to the in-app Trash (#863).
  installTrashLocation();

  const leftExplorer = $derived(windowTabsManager.getActiveExplorer());
  const launchHomePath = resolveLaunchHomePath();

  // The island arrangement belongs to the applied layout theme (#1306), so
  // the in-pane miller suppression (ExplorerPane) keys off the exact same
  // condition — a divergent copy once double-mounted the columns (#434).
  const millerAsLeftIsland = $derived(
    layoutStore.islands && !settingsStore.showSidebar && (leftExplorer?.millerLayers ?? 0) > 0
  );

  /** Convert a filesystem path to a URL usable in src/background-image. */
  function convertFileSrc(path: string): string {
    // Tauri asset protocol
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      return `asset://localhost/${encodeURIComponent(path)}`;
    }
    return `file://${path}`;
  }

  // Get active explorer from window tabs manager
  function getActiveExplorer(): ExplorerInstance | undefined {
    return windowTabsManager.getActiveExplorer();
  }

  const refreshAllPanes = () => windowTabsManager.refreshAllPanes();

  // Update localStorage whenever the active explorer's path or viewMode changes
  $effect(() => {
    const explorer = getActiveExplorer();
    if (explorer) {
      // Access reactive properties to subscribe
      const _path = explorer.currentPath;
      const _viewMode = explorer.viewMode;
      saveFocusedWindowState(_path, _viewMode);
    }
  });

  // Apply zoom level reactively. --app-zoom mirrors the factor so fullscreen
  // overlays can cancel the root zoom in CSS (zoom: calc(1 / var(--app-zoom)))
  // and actually cover the visible viewport (#236).
  $effect(() => {
    document.documentElement.style.zoom = `${settingsStore.zoomLevel}%`;
    document.documentElement.style.setProperty("--app-zoom", String(settingsStore.zoomLevel / 100));
  });

  // Push the configured ffmpeg path to the backend on startup and whenever it
  // changes, so video/audio thumbnails can find ffmpeg when it isn't on PATH.
  $effect(() => {
    void setFfmpegPath(settingsStore.ffmpegPath);
  });

  // Apply background opacity reactively (for window transparency)
  $effect(() => {
    const opacity = settingsStore.backgroundOpacity / 100;
    document.documentElement.style.setProperty("--bg-opacity", String(opacity));
  });

  // Apply the opt-in "premium" surface treatment (#437). When on, themes
  // expose their accent-tinted hairlines, glow shadows, breadcrumb pills,
  // translucent surfaces, and static depth backdrop; when off, a higher-
  // specificity :not([data-premium="true"]) rule in each theme restores the
  // prior flatter/high-contrast values.
  $effect(() => {
    if (settingsStore.premiumTheme) {
      document.documentElement.setAttribute("data-premium", "true");
    } else {
      document.documentElement.removeAttribute("data-premium");
    }
  });

  // Native window material (macOS vibrancy with blur, Windows Mica/Acrylic)
  // is a capability independent of the layout theme (#1306): the window
  // background goes transparent so the material shows wherever the layout
  // leaves the window uncovered. Layouts may react to [data-native-backdrop].
  $effect(() => {
    document.documentElement.toggleAttribute("data-native-backdrop",
      (settingsStore.macOsVibrancy && settingsStore.vibrancyBlur) || settingsStore.windowsBackdrop !== "off");
  });

  // Windows Mica/Acrylic: apply the native backdrop with a theme-matched tint
  // at runtime so changing material, opacity, or theme updates the live window
  // (the tint controls how see-through Acrylic is). Re-runs when any of those
  // reactive inputs change; theme is read so the tint follows the palette.
  $effect(() => {
    void settingsStore.windowsBackdrop;
    void settingsStore.windowsBackdropOpacity;
    void settingsStore.theme;
    applyWindowsBackdrop();
  });

  // Lightweight file-picker mode (portal windows): ?picker=open|save.
  // Rendered instead of the full app — see FilePicker.svelte / portal.rs.
  const pickerInfo: PickerInfo | null = (() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("picker");
    if (mode !== "open" && mode !== "save") return null;
    return {
      mode,
      token: params.get("token") ?? "",
      multiple: params.get("multiple") === "1",
      directory: params.get("directory") === "1",
      folder: params.get("folder"),
      name: params.get("name") ?? "",
      title: params.get("title") ?? "",
      extensions: params.getAll("extension"),
    };
  })();

  // Readiness requires loaded settings, registered commands, and a completed
  // listing (including empty directories). Two frame callbacks give Svelte's
  // committed DOM a paint opportunity before reporting; this is a readiness
  // signal, not proof of pixels presented by the OS compositor.
  let firstPaintReported = false;
  let commandsReady = $state(false);
  let settingsReady = $state(false);
  let listingReadyReported = false;
  let appReadyReported = false;
  $effect(() => {
    if (listingReadyReported) return;
    const explorer = windowTabsManager.getActiveExplorer();
    if (!explorer?.currentPath || explorer.state.loading || explorer.state.error) return;
    listingReadyReported = true;
    markStartup("list-ready");
  });
  $effect(() => {
    if (firstPaintReported || !commandsReady || !settingsReady) return;
    const explorer = windowTabsManager.getActiveExplorer();
    if (!explorer?.currentPath || explorer.state.loading || explorer.state.error) return;
    // Every readiness precondition is satisfied here; the remaining interval to
    // `ui-ready` is frame scheduling, which the attribution report keeps as its
    // own phase instead of folding into app work. A navigation that lands
    // between here and the second frame re-runs this effect, so the mark is
    // latched: a repeat would move time out of app work and into frame
    // scheduling, and the qualification parser rejects duplicated markers.
    if (!appReadyReported) {
      appReadyReported = true;
      markStartup("app-ready");
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        firstPaintReported = true;
        reportStartupReady();
        session?.markCoreReady();
      });
    });
    return () => cancelAnimationFrame(frame);
  });

  // A failed initial path is still a usable shell for recovery. Keep that
  // background-service trigger separate from successful startup measurement.
  $effect(() => {
    if (!commandsReady || !settingsReady) return;
    const explorer = windowTabsManager.getActiveExplorer();
    if (!explorer?.state.error || explorer.state.loading) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => session?.markBackgroundReady());
    });
    return () => cancelAnimationFrame(frame);
  });

  let session = $state.raw<ReturnType<typeof startWindowSession> | undefined>();
  const recoveryCount = $derived(session?.recovery?.state?.items.length ?? 0);
  const recoveryError = $derived(session?.recovery?.error ?? null);
  $effect(() => {
    if (dialogStore.isFileRecoveryOpen) void session?.recovery?.start();
  });
  onMount(() => {
    const lifetime = new AbortController();
    const start = (beforeInitialListing?: (signal: AbortSignal) => void) => {
      if (lifetime.signal.aborted) return;
      session = startWindowSession({
        picker: pickerInfo !== null,
        homePath: launchHomePath,
        settingsReady: () => { settingsReady = true; },
        commandsReady: () => { commandsReady = true; },
        beforeInitialListing,
      });
    };
    // Release builds start synchronously. Hook builds install the real-listing
    // observer before initialization, including newly created webviews.
    const hooks = pickerInfo ? null : loadE2EHooks();
    if (hooks) void hooks.then(({ prepareWindowSessionProbe }) => start(prepareWindowSessionProbe))
      .catch((error) => console.error("Window probe initialization failed:", error));
    else start();
    return () => { jobRevealController.abort(); lifetime.abort(); session?.dispose(); session = undefined; };
  });
</script>

<!-- Theme background layer - sits behind glassmorphism stack, targetable by themes via --theme-background-image -->
<div
  class="theme-background-layer"
  data-region="backdrop"
  aria-hidden="true"
  style:background-image={settingsStore.backgroundImage ? `url('${convertFileSrc(settingsStore.backgroundImage)}')` : undefined}
  style:filter={settingsStore.backgroundImage && settingsStore.backgroundBlur > 0 ? `blur(${settingsStore.backgroundBlur}px)` : undefined}
></div>
<AnimatedBackground />

{#if !pickerInfo}
<main class="explorer" data-region="app">
  <TitleBar />
  <div class="main-content" data-region="main" class:no-sidebar={!settingsStore.showSidebar}>
    {#if settingsStore.showSidebar}
      <Sidebar />
    {/if}
    {#if millerAsLeftIsland && leftExplorer}
      <div class="miller-island" data-region="miller-island" data-pane-id={windowTabsManager.activePaneId}>
        <MillerColumns explorer={leftExplorer} paneId={windowTabsManager.activePaneId} />
      </div>
    {/if}
    {#snippet paneAndPreview()}
      <PaneContainer />
      {#if settingsStore.showPreviewPane}
        {#await import("$lib/components/PreviewPane.svelte") then { default: PreviewPane }}
          <div class="preview-island" data-region="preview" class:vertical={settingsStore.resolvedPreviewPanePosition !== "right"}>
            <PreviewPane />
          </div>
        {/await}
      {/if}
    {/snippet}
    <div class="workspace-container">
      <div class="workspace-layout">
        <div class="workspace-panes">
          {#if settingsStore.resolvedPreviewPanePosition === "right"}
            {@render paneAndPreview()}
          {:else}
            <!-- Bottom/top dock: panes and preview share the center column. -->
            <div class="pane-preview-stack" class:preview-top={settingsStore.resolvedPreviewPanePosition === "top"}>
              {@render paneAndPreview()}
            </div>
          {/if}
        </div>
        {#await import("$lib/components/PluginInspector.svelte") then { default: PluginInspector }}
          <PluginInspector />
        {/await}
      </div>
    </div>
  </div>
  {#if terminalPanelStore.everOpened && settingsStore.enableTerminal}
    <!-- Lazy: xterm.js only loads on first open. Stays mounted afterwards so
         hiding the panel keeps the shell session alive. -->
    {#await import("$lib/components/TerminalPanel.svelte") then { default: TerminalPanel }}
      <TerminalPanel />
    {/await}
  {/if}
  {#if settingsStore.showStatusBar}
    <StatusBar>
      <FileRecoveryNotice count={recoveryCount}
        error={recoveryError} onOpen={() => dialogStore.openFileRecovery()} />
    </StatusBar>
  {:else if recoveryCount > 0 || recoveryError}
    <div class="recovery-attention" aria-live="polite">
      <FileRecoveryNotice count={recoveryCount} error={recoveryError} onOpen={() => dialogStore.openFileRecovery()} />
    </div>
  {/if}
</main>

<CrashNotice />
<UpdateNotice />
{/if}

<WindowDialogs {pickerInfo} recovery={session?.recovery} onFilesChanged={refreshAllPanes} />

<style>
  .recovery-attention {
    display: flex;
    justify-content: flex-end;
    flex-shrink: 0;
    padding: 3px 12px;
    background: var(--background-card-secondary);
    box-shadow: 0 -1px 0 var(--divider);
    font-size: var(--font-size-caption);
  }

  /* Windows 11 Fluent Design System */
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(button) {
    appearance: none;
    -webkit-appearance: none;
  }

  /* One themed focus ring for every keyboard-focused control (#797), in
     place of the engine's `outline: auto`. It is inset so a clipping scroller
     or tab strip cannot hide it. Components that draw their own ring override
     it with a more specific selector. */
  :global(:focus-visible) {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  @font-face {
    font-family: "NerdFontsSymbols";
    src: url("/fonts/SymbolsNerdFont-Regular.ttf") format("truetype");
    font-weight: normal;
    font-style: normal;
    font-display: swap;
  }

  :global(.nf-icon) {
    font-family: "NerdFontsSymbols", monospace;
    font-style: normal;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  :global(:root) {
    /* Typography */
    --font-family: "Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "Cantarell", "Noto Sans", sans-serif;
    --font-size-caption: 11px;
    --font-size-body: 14px;
    --font-size-subtitle: 16px;
    --font-size-title: 20px;
    --font-weight-normal: 400;
    --font-weight-medium: 500;
    --font-weight-semibold: 600;
    --font-weight-bold: 700;
    --letter-spacing-tight: -0.01em;
    --letter-spacing-normal: 0em;
    --letter-spacing-wide: 0.04em;
    --line-height-tight: 1.2;
    --line-height-normal: 1.5;

    /* Radii */
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --radius-pill: 999px;
    --radius-window: 10px;

    /* Transitions */
    --transition-fast: 80ms cubic-bezier(0.25, 0.1, 0.25, 1);
    --transition-normal: 150ms cubic-bezier(0.25, 0.1, 0.25, 1);
    --transition-slow: 250ms cubic-bezier(0, 0, 0, 1);

    /* Spacing */
    --spacing-xxs: 2px;
    --spacing-xs: 4px;
    --spacing-sm: 8px;
    --spacing-md: 12px;
    --spacing-lg: 16px;
    --spacing-xl: 24px;

    /* Shadows */
    --shadow-subtle: 0 1px 2px rgba(0, 0, 0, 0.04);
    --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.06), 0 0 1px rgba(0, 0, 0, 0.04);

    /* Selection indicator */
    --selection-indicator-width: 3px;

    /* Z-index scale — every overlay layer uses these tokens so layers can't
       silently collide. Component-local stacking inside panes stays < 200. */
    --z-modal: 1000;          /* modal dialogs + their backdrops (Modal.svelte) */
    --z-modal-popover: 1100;  /* dropdowns that must beat an open modal (pickers) */
    --z-menu: 1200;           /* context menus */
    --z-progress: 1300;       /* corner progress panel — visible above modals */
    --z-toast: 1400;          /* notifications — topmost */
  }

  /* Window frame styling for transparent decorationless window */
  :global(html) {
    background: transparent;
    border-radius: var(--radius-window);
    overflow: hidden;
  }


  :global(body) {
    font-family: var(--font-family);
    font-weight: var(--font-weight-normal);
    font-size: var(--font-size-body);
    line-height: var(--line-height-normal);
    letter-spacing: var(--letter-spacing-tight);
    color: var(--text-primary);
    /* UI chrome is not selectable by default — prevents stray text selections
       bleeding across file rows, miller columns, breadcrumbs etc. from
       shift-click, double-click, or drag interactions. Components that host
       real selectable text (inputs, contenteditable, the preview pane) opt
       back in with `user-select: text` explicitly. (#38) */
    user-select: none;
    -webkit-user-select: none;
    background: color-mix(in srgb, var(--background-mica) calc(var(--bg-opacity, 1) * 100%), transparent);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    /* Window frame — use inset box-shadow instead of border to avoid
       a visible colored strip at the top from border + border-radius */
    border-radius: var(--radius-window);
    border: none;
    box-shadow: inset 0 0 0 1px var(--surface-stroke);
    overflow: hidden;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    margin: 0;
  }

  /* Re-enable text selection for genuinely textual UI surfaces (#38) */
  :global(input),
  :global(textarea),
  :global([contenteditable="true"]),
  :global(.preview-pane),
  :global(.preview-pane *) {
    user-select: text;
    -webkit-user-select: text;
  }

  /* Selection styling */
  :global(::selection) {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
    color: inherit;
  }

  /* Scrollbar styling - Windows 11 style */
  :global(::-webkit-scrollbar) {
    width: 8px;
    height: 8px;
  }

  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }

  :global(::-webkit-scrollbar-thumb) {
    background: var(--text-tertiary);
    border: 2px solid transparent;
    border-radius: var(--radius-pill);
    background-clip: padding-box;
  }

  :global(::-webkit-scrollbar-thumb:hover) {
    background: var(--text-secondary);
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  :global(::-webkit-scrollbar-corner) {
    background: transparent;
  }

  /* Theme background layer: behind glassmorphism, targetable by themes */
  .theme-background-layer {
    position: fixed;
    /* Extend beyond edges to prevent blur transparency at borders */
    inset: -20px;
    z-index: -1;
    background: var(--theme-background-image, var(--theme-background-color, transparent));
    background-size: cover;
    background-position: center;
    opacity: var(--bg-opacity, 1);
    pointer-events: none;
  }

  .explorer {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: color-mix(in srgb, var(--background-mica) calc(var(--bg-opacity, 1) * 100%), transparent);
    backdrop-filter: blur(60px) saturate(125%);
    -webkit-backdrop-filter: blur(60px) saturate(125%);
  }

  /* Fullscreen preview (#379): on Chromium/WebView2 a backdrop-filter makes
     .explorer the containing block for position:fixed descendants, so the
     "fullscreen" preview laid out inside it and was clipped by the preview
     island's overflow:hidden — the rest of the app stayed visible around
     the image on Windows. The fullscreen preview covers the window with an
     opaque background, so suspending the blur (and the island's clip) for
     that moment is invisible. */
  :global([data-preview-fullscreen]) .explorer {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  /* Fullscreen is inside this stacking context. It must cover the later
     status bar (1) and terminal resize handle (2), below root dialogs (#970). */
  :global([data-preview-fullscreen]) .main-content {
    z-index: 3;
  }

  /* Mica effect gradient overlay — disabled due to gradient banding artifacts */


  .main-content {
    display: flex;
    flex: 1;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }

  /* Size the inspector against the space left after sidebar/Miller islands.
     A narrow workspace stacks it below the panes instead of shrinking Files. */
  .workspace-container {
    container: explorer-workspace / inline-size;
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .workspace-layout,
  .workspace-panes {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  @container explorer-workspace (max-width: 1000px) {
    .workspace-layout { flex-direction: column; }
  }

  /* Layout-theme spacing (#1306): unset, panels sit edge to edge. */
  .main-content {
    gap: var(--layout-gap, 0px);
    padding: var(--layout-inset, 0px);
  }

  .workspace-layout,
  .workspace-panes,
  .pane-preview-stack {
    gap: var(--layout-gap, 0px);
  }

  /* Native window material (macOS vibrancy, Windows Mica/Acrylic) is
     independent of the layout theme: the window background goes transparent
     so the material shows wherever the layout leaves it uncovered. */
  :global([data-native-backdrop]) :global(body) {
    background: transparent;
    box-shadow: none;
  }

  :global([data-native-backdrop]) .explorer {
    background: var(--vibrancy-tint, transparent);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  /* Windows Acrylic strength: a theme-coloured tint over the whole window,
     driven by the Backdrop Opacity slider. Higher alpha = more opaque = less
     of the native Acrylic blur shows through. Must follow the
     [data-native-backdrop] body rule above to win the equal-specificity tie.
     The native Acrylic tint colour is ignored on Windows 11, so this is the
     only reliable strength control. */
  :global([data-win-acrylic]) :global(body) {
    background: var(--win-acrylic-tint, transparent);
  }

  /* Miller columns hoisted beside the panes (island arrangement only). Its
     chrome comes from the layout theme. */
  .miller-island {
    flex-shrink: 0;
    overflow: hidden;
    display: flex;
    min-height: 0;
  }

  /* Preview pane wrapper: a top-level layout panel. */
  .preview-island {
    flex-shrink: 0;
    display: flex;
    min-height: 0;
    border-radius: var(--layout-radius, 0px);
    border: var(--layout-border, none);
    box-shadow: var(--layout-shadow, none);
  }

  /* Bottom/top dock: island is a column so the preview dock's inline height
     drives the island height and the dock stretches to full column width. */
  .preview-island.vertical {
    flex-direction: column;
    /* The child supplies its live draft size; constrain allocation without
       replacing that size with the last committed preference. */
    max-height: max(4px, calc(100% - 120px));
    min-height: 0;
    min-width: 0;
  }

  /* Center column when the preview is docked bottom (default order) or top
     (column-reverse). min-height:0 keeps the file list scrollable. */
  .pane-preview-stack {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .pane-preview-stack.preview-top {
    flex-direction: column-reverse;
  }
</style>
