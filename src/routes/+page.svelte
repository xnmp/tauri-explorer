<!--
  Main Explorer page - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-w3t, tauri-explorer-npjh, tauri-explorer-1ex, tauri-explorer-auj, tauri-explorer-npjh.4
-->
<script lang="ts">
  import "@fontsource-variable/inter";
  import { onMount } from "svelte";
  import { getAlwaysActiveTerminalCommandId, isShellReservedKey } from "$lib/domain/terminal-keys";
  import { E2E_HOOKS_ENABLED } from "$lib/domain/e2e-hooks";
  import { themeStore } from "$lib/state/theme.svelte";
  import { startConfigWatch } from "$lib/state/config-watch";
  import { settingsStore } from "$lib/state/settings.svelte";
import { windowSizeStore } from "$lib/state/window-size.svelte";
  import { applyWindowsBackdrop } from "$lib/state/window-backdrop";
  import { folderViewsStore } from "$lib/state/folder-views.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { resolveLaunchHomePath, startWindowTitleSync } from "$lib/state/window-title.svelte";
  import { markStartup, reportFirstPaint } from "$lib/state/startup-timing";
  import { warmMode, runWarmWindow, spawnWarmWindow } from "$lib/state/warm-window";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { registerAllCommands } from "$lib/state/command-definitions";
  import { pluginRegistry } from "$lib/plugins/registry.svelte";
  import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
  import { executeCommand, getCommand } from "$lib/state/commands.svelte";
  import { keybindingsStore } from "$lib/state/keybindings.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { toastStore } from "$lib/state/toast.svelte";
  import { createDialogCrashHandler, loadDialogComponent, type LazyDialogRequest } from "$lib/domain/lazy-dialog";
  import { bookmarksStore } from "$lib/state/bookmarks.svelte";
  import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
  import { saveFocusedWindowState } from "$lib/state/focused-window";
  import { terminalPanelStore } from "$lib/state/terminal.svelte";
  import { setFfmpegPath } from "$lib/api/system";
  import { useNativeDropHandler } from "$lib/composables/use-native-drop-handler";
  import { useFileWatchers } from "$lib/composables/use-file-watchers";
  import { useWindowLifecycle } from "$lib/composables/use-window-lifecycle";
  import "$lib/themes/index.css";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import CrashNotice from "$lib/components/CrashNotice.svelte";
  import UpdateNotice from "$lib/components/UpdateNotice.svelte";
  import ShortcutCheatsheet from "$lib/components/ShortcutCheatsheet.svelte";
    import type { PickerInfo } from "$lib/components/FilePicker.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
    import PaneContainer from "$lib/components/PaneContainer.svelte";
  import ProgressDialog from "$lib/components/ProgressDialog.svelte";
  import ToastOverlay from "$lib/components/ToastOverlay.svelte";
  import type { Component } from "svelte";
  import { conflictResolver } from "$lib/state/conflict-resolver.svelte";
  import { gitStatusStore } from "$lib/state/git-status.svelte";
  import { initTabTransferListener } from "$lib/state/tab-transfer";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import AnimatedBackground from "$lib/components/AnimatedBackground.svelte";
  import MillerColumns from "$lib/components/MillerColumns.svelte";

  // First milestone: the app bundle has parsed and begun executing. The gap
  // from boot t0 to here is the JS download+parse cost the lazy-loading targets.
  markStartup("bundle-exec");

  const leftExplorer = $derived(windowTabsManager.getActiveExplorer());
  const launchHomePath = resolveLaunchHomePath();

  // ONE island-mode condition (#407, #434): macOS vibrancy, a Windows native
  // backdrop, and the platform-independent Floating Islands setting all drive
  // the same [data-vibrancy] island CSS. The derived now lives on settingsStore
  // so the in-pane miller suppression (ExplorerPane) keys off the exact same
  // condition — a local copy here drifted from ExplorerPane's `macOsVibrancy`
  // check and double-mounted the columns (#434).
  const islandMode = $derived(settingsStore.islandMode);
  const millerAsLeftIsland = $derived(
    islandMode && !settingsStore.showSidebar && (leftExplorer?.millerLayers ?? 0) > 0
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

  // Rarely-opened dialogs are code-split out of the startup bundle and loaded
  // on first open. They stay mounted after loading so close transitions and
  // internal state behave exactly as with a static import.
  let ThemePicker = $state<Component<{ open: boolean; onClose: () => void }> | null>(null);
  let SettingsDialog = $state<Component<{ open: boolean; onClose: () => void }> | null>(null);
  let WorkspaceDialog = $state<Component<{ open: boolean; onClose: () => void }> | null>(null);
  let BulkRenameDialog = $state<Component<any> | null>(null);
  let QuickOpen = $state<Component<{ open: boolean; onClose: () => void }> | null>(null);
  let CommandPalette = $state<Component<{ open: boolean; onClose: () => void }> | null>(null);
  let ContentSearchDialog = $state<Component<{ open: boolean; onClose: () => void }> | null>(null);
  let FilePicker = $state<Component<{ info: PickerInfo }> | null>(null);
  let ConflictDialog = $state<Component<any> | null>(null);
  let JobsPanel = $state<Component<{ open: boolean; onClose: () => void }> | null>(null);
  let OptionPicker = $state<Component<any> | null>(null);
  let UserReportDialog = $state<Component<any> | null>(null);

  // A failed chunk load must roll back the dialog's open-state (otherwise
  // dialogStore.hasModalOpen soft-locks every shortcut with nothing visible
  // to close — #584) and tell the user. loadDialogComponent enforces both.
  const loadDialog = <T,>(request: LazyDialogRequest<T>): void => void loadDialogComponent(request, (message) => toastStore.error(message));
  // Same rollback contract for the failure loadDialog can't see: a dialog
  // that throws while mounting (e.g. #585's duplicate theme id crashing the
  // picker's keyed each). Used as <svelte:boundary onerror>.
  const dialogCrash = (label: string, rollback?: () => void) => createDialogCrashHandler(label, rollback, (message) => toastStore.error(message));

  $effect(() => {
    if (dialogStore.isThemePickerOpen && !ThemePicker) {
      loadDialog({ label: "Theme Picker", load: () => import("$lib/components/ThemePicker.svelte"), onLoaded: (c) => (ThemePicker = c), onFailure: () => dialogStore.closeThemePicker() });
    }
    if (dialogStore.isSettingsOpen && !SettingsDialog) {
      loadDialog({ label: "Settings", load: () => import("$lib/components/SettingsDialog.svelte"), onLoaded: (c) => (SettingsDialog = c), onFailure: () => dialogStore.closeSettings() });
    }
    if (dialogStore.isWorkspaceOpen && !WorkspaceDialog) {
      loadDialog({ label: "Workspaces", load: () => import("$lib/components/WorkspaceDialog.svelte"), onLoaded: (c) => (WorkspaceDialog = c), onFailure: () => dialogStore.closeWorkspace() });
    }
    if (dialogStore.isBulkRenameOpen && !BulkRenameDialog) {
      loadDialog({ label: "Bulk Rename", load: () => import("$lib/components/BulkRenameDialog.svelte"), onLoaded: (c) => (BulkRenameDialog = c), onFailure: () => dialogStore.closeBulkRename() });
    }
    if (dialogStore.isQuickOpenOpen && !QuickOpen) {
      loadDialog({ label: "Quick Open", load: () => import("$lib/components/QuickOpen.svelte"), onLoaded: (c) => (QuickOpen = c), onFailure: () => dialogStore.closeQuickOpen() });
    }
    if (dialogStore.isCommandPaletteOpen && !CommandPalette) {
      loadDialog({ label: "Command Palette", load: () => import("$lib/components/CommandPalette.svelte"), onLoaded: (c) => (CommandPalette = c), onFailure: () => dialogStore.closeCommandPalette() });
    }
    if (dialogStore.isContentSearchOpen && !ContentSearchDialog) {
      loadDialog({ label: "Content Search", load: () => import("$lib/components/ContentSearchDialog.svelte"), onLoaded: (c) => (ContentSearchDialog = c), onFailure: () => dialogStore.closeContentSearch() });
    }
    if (pickerInfo && !FilePicker) {
      // Portal picker windows render nothing but FilePicker; there is no
      // open-flag to roll back — the toast is the only recovery available.
      loadDialog({ label: "File Picker", load: () => import("$lib/components/FilePicker.svelte"), onLoaded: (c) => (FilePicker = c) });
    }
    if (conflictResolver.isActive && !ConflictDialog) {
      loadDialog({ label: "Conflict dialog", load: () => import("$lib/components/ConflictDialog.svelte"), onLoaded: (c) => (ConflictDialog = c), onFailure: () => conflictResolver.resolve("cancel", true) });
    }
    if (dialogStore.isJobsPanelOpen && !JobsPanel) {
      loadDialog({ label: "Jobs Panel", load: () => import("$lib/components/JobsPanel.svelte"), onLoaded: (c) => (JobsPanel = c), onFailure: () => dialogStore.closeJobsPanel() });
    }
    if (dialogStore.isPickerOpen && !OptionPicker) {
      loadDialog({ label: "Option Picker", load: () => import("$lib/components/OptionPicker.svelte"), onLoaded: (c) => (OptionPicker = c), onFailure: () => dialogStore.closePicker() });
    }
    if (dialogStore.isUserReportOpen && !UserReportDialog) {
      loadDialog({ label: "Report dialog", load: () => import("$lib/components/UserReportDialog.svelte"), onLoaded: (c) => (UserReportDialog = c), onFailure: () => dialogStore.closeUserReport() });
    }
  });

  // Initialize composables
  const nativeDropHandler = useNativeDropHandler({ getActiveExplorer, refreshAllPanes });
  const fileWatchers = useFileWatchers({
    getAllExplorers: () => windowTabsManager.getAllExplorers(),
  });
  const windowLifecycle = useWindowLifecycle({
    getActiveExplorer,
    saveTabs: () => windowTabsManager.save(),
  });

  async function handleKeydown(event: KeyboardEvent): Promise<void> {
    // Track the Super key's held state before any early return — WebKitGTK
    // never maps Super into event.metaKey, the store overlays it (#244).
    keybindingsStore.trackModifierKey(event, true);
    const isModifier = event.ctrlKey || event.metaKey;

    // Skip if focus is in an input field (except for special cases)
    const target = event.target as HTMLElement;
    const isInputField = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
    const isTerminalFocus = !!target.closest?.(".terminal-panel");

    // Ctrl+` owns the terminal surface itself, rather than being an Explorer
    // app-level shortcut. Keep it ahead of terminal key ownership so it can
    // hide a focused terminal while leaving every terminal-app binding alone.
    if ((event.key === "`" || event.code === "Backquote") && isModifier && !dialogStore.hasModalOpen) {
      if (!settingsStore.enableTerminal) return; // feature flag (#175)
      event.preventDefault();
      terminalPanelStore.toggle();
      return;
    }

    // A terminal-hosted application owns every key except the small,
    // availability-aware core-navigation allowlist in isShellReservedKey.
    // This must run before every page-level app shortcut (including Ctrl+F
    // and Escape) so a new global shortcut cannot accidentally steal input
    // from a focused terminal application.
    if (isTerminalFocus) {
      const coreCommandId = getAlwaysActiveTerminalCommandId(event);
      const coreCommandAvailable =
        coreCommandId !== undefined && keybindingsStore.matchesAnyBinding(event, (id) => {
          if (id !== coreCommandId) return false;
          const cmd = getCommand(id);
          return !cmd?.when || cmd.when();
        });
      const terminalToggleChordPrefix = keybindingsStore.matchesChordPrefixForCommand(
        event,
        "general.openTerminal",
      );
      const terminalToggleChordActive = keybindingsStore.isChordActiveForCommand(
        event,
        "general.openTerminal",
      );
      if (
        isShellReservedKey(event, {
          coreCommandAvailable,
          terminalToggleChordPrefix,
          terminalToggleChordActive,
        })
      ) {
        // A terminal-owned key still consumes any pending Explorer chord,
        // just as findMatchingCommand does for a non-matching suffix. Without
        // this, a later terminal key could complete the stale chord (#608).
        if (keybindingsStore.isChordActive) keybindingsStore.cancelChord();
        return;
      }
    }

    // Escape closes any open modal dialog
    if (event.key === "Escape" && dialogStore.hasModalOpen) {
      event.preventDefault();
      dialogStore.closeAll();
      return;
    }

    // Ctrl+F: open the directory filter. Handled explicitly *before* the
    // input-field early-return so pressing it again while the filter input is
    // focused is swallowed — this stops the WebView's native find bar — and is
    // a no-op rather than a toggle. (Ctrl+Shift+F = Search in Files is excluded.)
    if (
      (event.key === "f" || event.key === "F") &&
      isModifier &&
      !event.shiftKey &&
      !event.altKey &&
      !dialogStore.hasModalOpen
    ) {
      event.preventDefault();
      const explorer = getActiveExplorer();
      if (explorer && !explorer.showFilter) explorer.openFilter();
      return;
    }

    // Escape exits the directory filter from anywhere. The filter input handles
    // its own Escape (and stops propagation); this covers the case where focus
    // is on the file list or elsewhere outside an input.
    if (event.key === "Escape" && !isInputField) {
      const explorer = getActiveExplorer();
      if (explorer?.showFilter) {
        event.preventDefault();
        explorer.closeFilter();
        return;
      }
    }

    // Skip shortcut handling (including hardcoded shortcuts below) if in an
    // input field or a modal dialog is open — e.g. Ctrl+J while typing in a
    // rename input must not open the jobs panel. Terminal focus has already
    // been filtered through the ownership gate above.
    if ((isInputField && !isTerminalFocus) || dialogStore.hasModalOpen) {
      return;
    }

    // Ctrl+J: Open jobs panel (hardcoded)
    if (event.key === "j" && isModifier) {
      event.preventDefault();
      dialogStore.openJobsPanel();
      return;
    }

    // Ctrl+,: Open settings (hardcoded, not customizable)
    if (event.key === "," && isModifier) {
      event.preventDefault();
      dialogStore.openSettings();
      return;
    }

    // Ctrl+\ or Ctrl+|: Toggle dual pane (hardcoded due to special key handling)
    const isBackslash = event.key === "\\" || event.key === "|" || event.code === "Backslash";
    if (isBackslash && isModifier) {
      event.preventDefault();
      windowTabsManager.toggleDualPane();
      return;
    }

    // Find matching command from keybindings store, skipping commands whose `when` guard fails.
    // This ensures that when multiple commands share a shortcut (e.g. F5 for refresh vs copy-to-other-pane),
    // the first available one is selected rather than the first registered one.
    // Chord shortcuts (e.g., "Alt+M T") return "chord:waiting" when the prefix is matched.
    const matchingCommandId = keybindingsStore.findMatchingCommand(event, (id) => {
      const cmd = getCommand(id);
      return !cmd?.when || cmd.when();
    });

    if (matchingCommandId === "chord:waiting") {
      event.preventDefault();
      return;
    }
    if (matchingCommandId) {
      event.preventDefault();
      await executeCommand(matchingCommandId);
      return;
    }
  }

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

  // Apply vibrancy mode attribute. It drives the "floating island" CSS shared
  // by macOS vibrancy, the Windows Mica/Acrylic backdrop, and the
  // platform-independent floatingIslands setting (#277). Native backdrops
  // need the app background to go transparent so the effect shows through;
  // without one, the no-blur path paints a themed depth gradient instead —
  // same island layout, no transparency required (works on Linux).
  $effect(() => {
    const windowsBackdrop = settingsStore.windowsBackdrop !== "off";
    const nativeBackdrop =
      (settingsStore.macOsVibrancy && settingsStore.vibrancyBlur) || windowsBackdrop;
    if (islandMode) {
      document.documentElement.setAttribute("data-vibrancy", "");
      if (nativeBackdrop) {
        document.documentElement.removeAttribute("data-vibrancy-no-blur");
      } else {
        document.documentElement.setAttribute("data-vibrancy-no-blur", "");
      }
    } else {
      document.documentElement.removeAttribute("data-vibrancy");
      document.documentElement.removeAttribute("data-vibrancy-no-blur");
    }
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
    };
  })();

  // Cold-start timing: fire once when the first directory listing is visible
  // (active explorer has entries and is no longer loading). Reports a summary
  // to the Rust log so it sits next to the backend `Startup:` line. Idempotent
  // via reportFirstPaint's internal guard; the effect just stops reading once
  // it has fired. See src/lib/state/startup-timing.ts.
  let firstPaintReported = false;
  $effect(() => {
    if (firstPaintReported) return;
    const explorer = windowTabsManager.getActiveExplorer();
    if (explorer && !explorer.state.loading && explorer.displayEntries.length > 0) {
      firstPaintReported = true;
      reportFirstPaint();
    }
  });

  onMount(() => {
    markStartup("mount");

    // Initialize theme from saved preference
    themeStore.initTheme();

    // Picker windows skip the full app init (tabs, watchers, commands).
    if (pickerInfo) {
      settingsStore.init().then(() => themeStore.syncFromSettings());
      return;
    }

    // EXPERIMENTAL warm window (?warm=1 parked, ?warm=measure self-firing): a
    // hidden, fully-booted window for a future Ctrl+N. It runs the normal init
    // below (stores/tabs/listeners live), then registers its activate-listener
    // and signals readiness. It stays hidden until activated.
    const wmode = warmMode();
    if (wmode !== "off") {
      void runWarmWindow(wmode === "measure");
    }

    // Read launch data injected by Rust initialization_script (synchronous, no IPC).
    // Falls back to IPC for child windows or if injection is missing.
    const launchData = (window as any).__LAUNCH_DATA__ as
      | { cwd: string; home: string }
      | undefined;

    const searchParams = new URLSearchParams(window.location.search);
    const urlPath = searchParams.get("path");
    const urlViewMode = searchParams.get("viewMode") as import("$lib/state/types").ViewMode | null;

    const homePath = launchHomePath ?? "/home";
    const launchCwd = launchData?.cwd ?? null;

    // Child windows (spawned via Ctrl+N) have a ?path= param — skip
    // saved-state restoration so they open at the parent's path.
    const isChildWindow = !!urlPath;
    const defaultPath = urlPath || launchCwd || homePath;

    // If launched from a terminal with a meaningful cwd, pass it as an
    // override so the active pane navigates here directly instead of
    // racing two concurrent navigateTo calls.
    const isGenericCwd = !launchCwd || launchCwd === homePath || launchCwd === "/";
    const overridePath = (!isChildWindow && !isGenericCwd) ? launchCwd! : undefined;
    const tab = windowTabsManager.init(defaultPath, isChildWindow, overridePath);
    // Start only after tab initialization: creation paths already seed the
    // correct native title, and an eager empty-path write causes a visible
    // "Tauri Explorer" flash before the first explorer exists.
    const stopWindowTitleSync = startWindowTitleSync(
      () => windowTabsManager.getActiveExplorer()?.currentPath,
      homePath,
    );
    // Apply inherited view mode from parent window
    if (urlViewMode && tab) {
      const explorer = windowTabsManager.getActiveExplorer();
      explorer?.setViewMode(urlViewMode);
    }

    // Load settings and bookmarks from config files (async, non-blocking).
    // Plugins activate after settings load so persisted enable state is known.
    settingsStore.init().then(() => {
      themeStore.syncFromSettings();
      void pluginRegistry.initPlugins();
    });
    bookmarksStore.init();
    folderViewsStore.init();
    manualHiddenStore.init();

    // Initialize git status watcher so file badges update on changes
    gitStatusStore.initWatcherListener();

    // Cross-window tab moves: remove our copy when another window claims a
    // tab dragged out of this one.
    const stopTabTransfer = initTabTransferListener();

    // Apply edits made to settings.json / user themes outside the app (#599).
    const stopConfigWatch = startConfigWatch();

    // E2E hooks: the tauri-driver suite runs under Xvfb with no window
    // manager, where autofocused inline inputs (address bar, new-folder,
    // rename) blur — and cancel — the instant they open. These hooks drive
    // the SAME real backend operations (navigate / create_directory /
    // rename_entry / trash) the UI flows do, just without the headless-only
    // focus race. Compiled out of production builds (see E2E_HOOKS_ENABLED).
    if (E2E_HOOKS_ENABLED) {
      window.addEventListener("e2e-navigate", ((
        e: CustomEvent<string | { path: string; token?: string }>,
      ) => {
        const path = typeof e.detail === "string" ? e.detail : e.detail.path;
        const token = typeof e.detail === "string" ? undefined : e.detail.token;
        const navigation = windowTabsManager.getActiveExplorer()?.navigateTo(path);
        if (navigation && token) {
          void navigation.then(() => {
            document.documentElement.dataset.e2eNavigationComplete = token;
          });
        }
      }) as EventListener);

      // Restore the active pane to its file listing by closing any open commit
      // graph. The per-pane `gitGraph` state persists to localStorage, which is
      // shared across every tauri-driver session (same http://localhost origin),
      // so a spec that leaves the graph open (git-graph-pull) would otherwise
      // relaunch every later spec into graph mode — no `.file-list` ever renders
      // (#447). Specs call this via navigateTo before waiting for the listing.
      window.addEventListener("e2e-reset-view", (() => {
        for (const paneId of windowTabsManager.activePaneIds) {
          windowTabsManager.setPaneGitGraph(paneId, null);
        }
      }) as EventListener);

      window.addEventListener("e2e-file-op", ((
        e: CustomEvent<{ op: string; name?: string; path?: string }>,
      ) => {
        const explorer = windowTabsManager.getActiveExplorer();
        if (!explorer) return;
        const { op, name, path } = e.detail;
        const entry = path
          ? explorer.displayEntries.find((en) => en.path === path)
          : undefined;
        if (op === "new-folder" && name) {
          void explorer.createFolder(name);
        } else if (op === "rename" && entry && name) {
          explorer.startRename(entry);
          void explorer.rename(name);
        } else if (op === "delete" && entry) {
          void explorer.confirmDelete([entry]);
        }
      }) as EventListener);

      // WebKitWebDriver can execute injected scripts before these listeners
      // exist. Publish readiness through the DOM (visible across WebKit's
      // isolated JS worlds) so the driver can dispatch each navigation once
      // and wait for its matching completion token. Repeated polling dispatches
      // queue duplicate real listings and contaminate watcher timing probes.
      document.documentElement.dataset.e2eHooksReady = "true";
    }

    // Register all commands for the command palette (deferred to next tick)
    queueMicrotask(() => registerAllCommands());

    // Once this window is idle, prime the global warm-window pool so the next
    // Ctrl+N activates a pre-warmed window instead of paying webview-create
    // cost. Every REAL window primes — the Rust registry caps the pool at one,
    // so concurrent windows can't over-spawn. Warm windows themselves never
    // prime (wmode !== "off"): a warm window spawning another was the earlier
    // runaway-spawn bug. Deferred so it never competes with this window's own
    // first paint; settings are read at fire time, after settingsStore.init()
    // has resolved.
    if (wmode === "off") {
      setTimeout(() => {
        if (settingsStore.warmWindow) void spawnWarmWindow();
      }, 1500);
    }

    // Setup composables
    nativeDropHandler.setup();
    fileWatchers.setup();
    windowLifecycle.setup();

    // Global keyboard shortcuts
    window.addEventListener("keydown", handleKeydown);
    // Super-key held tracking (#244): keyup releases, blur resets (keyups
    // are lost when focus leaves the window with the modifier held).
    const handleKeyup = (e: KeyboardEvent) => keybindingsStore.trackModifierKey(e, false);
    const handleBlur = () => keybindingsStore.resetTrackedModifiers();
    window.addEventListener("keyup", handleKeyup);
    window.addEventListener("blur", handleBlur);

    // Window size tracking (#467): feeds the preview pane's "auto" dock mode
    // (settingsStore.resolvedPreviewPanePosition derives from this on every
    // read, no effect-driven sync needed) — sync once now for the initial
    // size, then on every resize.
    windowSizeStore.sync();
    const handleResize = () => windowSizeStore.sync();
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("keyup", handleKeyup);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("resize", handleResize);
      nativeDropHandler.cleanup();
      fileWatchers.cleanup();
      windowLifecycle.cleanup();
      stopWindowTitleSync();
      stopTabTransfer();
      stopConfigWatch();
    };
  });
</script>

<!-- Theme background layer - sits behind glassmorphism stack, targetable by themes via --theme-background-image -->
<div
  class="theme-background-layer"
  aria-hidden="true"
  style:background-image={settingsStore.backgroundImage ? `url('${convertFileSrc(settingsStore.backgroundImage)}')` : undefined}
  style:filter={settingsStore.backgroundImage && settingsStore.backgroundBlur > 0 ? `blur(${settingsStore.backgroundBlur}px)` : undefined}
></div>
<AnimatedBackground />

{#if pickerInfo}
  {#if FilePicker}
    <svelte:boundary onerror={dialogCrash("File Picker")}>
      <FilePicker info={pickerInfo} />
    </svelte:boundary>
  {/if}
{:else}
<main class="explorer">
  <TitleBar />
  <div class="main-content" class:no-sidebar={!settingsStore.showSidebar}>
    {#if settingsStore.showSidebar}
      <Sidebar />
    {/if}
    {#if millerAsLeftIsland && leftExplorer}
      <div class="miller-island">
        <MillerColumns explorer={leftExplorer} />
      </div>
    {/if}
    {#snippet paneAndPreview()}
      <PaneContainer />
      {#if settingsStore.showPreviewPane}
        {#await import("$lib/components/PreviewPane.svelte") then { default: PreviewPane }}
          <div class="preview-island" class:vertical={settingsStore.resolvedPreviewPanePosition !== "right"}>
            <PreviewPane />
          </div>
        {/await}
      {/if}
    {/snippet}
    {#if settingsStore.resolvedPreviewPanePosition === "right"}
      {@render paneAndPreview()}
    {:else}
      <!-- Bottom/top dock: PaneContainer + preview island stack in a column
           (column-reverse puts the island on top). Sidebar/miller stay left
           siblings; the stack owns the center column. -->
      <div class="pane-preview-stack" class:preview-top={settingsStore.resolvedPreviewPanePosition === "top"}>
        {@render paneAndPreview()}
      </div>
    {/if}
  </div>
  {#if terminalPanelStore.everOpened && settingsStore.enableTerminal}
    <!-- Lazy: xterm.js only loads on first open. Stays mounted afterwards so
         hiding the panel keeps the shell session alive. -->
    {#await import("$lib/components/TerminalPanel.svelte") then { default: TerminalPanel }}
      <TerminalPanel />
    {/await}
  {/if}
  {#if settingsStore.showStatusBar}
    <StatusBar />
  {/if}
</main>

<CrashNotice />
<UpdateNotice />
<ShortcutCheatsheet open={dialogStore.isShortcutsOpen} onClose={() => dialogStore.closeShortcuts()} />
{#if QuickOpen}
  <svelte:boundary onerror={dialogCrash("Quick Open", () => dialogStore.closeQuickOpen())}>
    <QuickOpen open={dialogStore.isQuickOpenOpen} onClose={() => dialogStore.closeQuickOpen()} />
  </svelte:boundary>
{/if}
{#if CommandPalette}
  <svelte:boundary onerror={dialogCrash("Command Palette", () => dialogStore.closeCommandPalette())}>
    <CommandPalette open={dialogStore.isCommandPaletteOpen} onClose={() => dialogStore.closeCommandPalette()} />
  </svelte:boundary>
{/if}
{#if ThemePicker}
  <svelte:boundary onerror={dialogCrash("Theme Picker", () => dialogStore.closeThemePicker())}>
    <ThemePicker open={dialogStore.isThemePickerOpen} onClose={() => dialogStore.closeThemePicker()} />
  </svelte:boundary>
{/if}
{#if OptionPicker}
  <svelte:boundary onerror={dialogCrash("Option Picker", () => dialogStore.closePicker())}>
    <OptionPicker />
  </svelte:boundary>
{/if}
{#if UserReportDialog}
  <svelte:boundary onerror={dialogCrash("Report dialog", () => dialogStore.closeUserReport())}>
    <UserReportDialog
      open={dialogStore.isUserReportOpen}
      onClose={() => dialogStore.closeUserReport()}
    />
  </svelte:boundary>
{/if}
{#if ContentSearchDialog}
  <svelte:boundary onerror={dialogCrash("Content Search", () => dialogStore.closeContentSearch())}>
    <ContentSearchDialog open={dialogStore.isContentSearchOpen} onClose={() => dialogStore.closeContentSearch()} />
  </svelte:boundary>
{/if}
{#if SettingsDialog}
  <svelte:boundary onerror={dialogCrash("Settings", () => dialogStore.closeSettings())}>
    <SettingsDialog open={dialogStore.isSettingsOpen} onClose={() => dialogStore.closeSettings()} />
  </svelte:boundary>
{/if}
{#if WorkspaceDialog}
  <svelte:boundary onerror={dialogCrash("Workspaces", () => dialogStore.closeWorkspace())}>
    <WorkspaceDialog open={dialogStore.isWorkspaceOpen} onClose={() => dialogStore.closeWorkspace()} />
  </svelte:boundary>
{/if}
{#if BulkRenameDialog}
  <svelte:boundary onerror={dialogCrash("Bulk Rename", () => dialogStore.closeBulkRename())}>
    <BulkRenameDialog
      open={dialogStore.isBulkRenameOpen}
      entries={dialogStore.bulkRenameEntries}
      onClose={() => dialogStore.closeBulkRename()}
      onComplete={() => refreshAllPanes()}
    />
  </svelte:boundary>
{/if}
{#each dialogRegistry.openDialogs as d (d.id)}
  {@const DialogComponent = d.component}
  <svelte:boundary onerror={dialogCrash(d.id, () => dialogRegistry.close(d.id))}>
    <DialogComponent open={true} {...d.props} onClose={() => dialogRegistry.close(d.id)} />
  </svelte:boundary>
{/each}
{#if JobsPanel}
  <svelte:boundary onerror={dialogCrash("Jobs Panel", () => dialogStore.closeJobsPanel())}>
    <JobsPanel
      open={dialogStore.isJobsPanelOpen}
      onClose={() => dialogStore.closeJobsPanel()}
    />
  </svelte:boundary>
{/if}
<ProgressDialog />
<!-- Toasts live at the app root (#417): mounted per-FileList they vanished in
     any pane mode without a file list (git graph), silently eating feedback. -->
<ToastOverlay />
{#if ConflictDialog}
  <svelte:boundary onerror={dialogCrash("Conflict dialog", () => conflictResolver.resolve("cancel", true))}>
    <ConflictDialog />
  </svelte:boundary>
{/if}
{/if}

<style>
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

  :global([data-preview-fullscreen][data-vibrancy]) .preview-island {
    overflow: visible;
  }

  /* Mica effect gradient overlay — disabled due to gradient banding artifacts */


  .main-content {
    display: flex;
    flex: 1;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }

  /* Floating-island mode: macOS vibrancy, Windows Mica/Acrylic, or the
     platform-independent floatingIslands setting (#277). */
  :global([data-vibrancy]) {
    --titlebar-opacity: 0;
    --sidebar-opacity: 0;
    --statusbar-opacity: 0;
    --vibrancy-island-bg:
      linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.04) 0%,
        transparent 40%,
        rgba(0, 0, 0, 0.02) 100%
      ),
      color-mix(in srgb, var(--vibrancy-island-card, var(--background-card)) 98%, transparent);
    /* Material weight encodes hierarchy: structural surfaces (sidebar) sit
       heavier — receded toward the backdrop — so content islands read as
       the lighter, foreground material. */
    --vibrancy-island-bg-structural:
      linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.03) 0%,
        transparent 40%,
        rgba(0, 0, 0, 0.03) 100%
      ),
      color-mix(in srgb, var(--vibrancy-island-card, var(--background-card)) 72%, transparent);
    --vibrancy-island-filter: blur(12px) brightness(1.08) saturate(1.2);
    --vibrancy-island-stroke: var(--surface-stroke);
    --vibrancy-island-radius: 14px;
    --vibrancy-island-glow:
      inset 0 0.5px 0 rgba(255, 255, 255, 0.09),
      inset 0 -0.5px 0 rgba(0, 0, 0, 0.2),
      0 1px 3px rgba(0, 0, 0, 0.15),
      0 4px 12px rgba(0, 0, 0, 0.2),
      0 12px 32px rgba(0, 0, 0, 0.15);
  }

  /* Translucent surfaces go frosty/solid when the user asks for it. */
  @media (prefers-reduced-transparency: reduce) {
    :global([data-vibrancy]) {
      --vibrancy-island-filter: none;
      --vibrancy-island-bg:
        linear-gradient(var(--background-card), var(--background-card)),
        var(--background-solid);
      --vibrancy-island-bg-structural:
        linear-gradient(var(--background-card), var(--background-card)),
        var(--background-solid);
    }
  }

  :global([data-vibrancy]) :global(body) {
    background: transparent;
    box-shadow: none;
  }

  :global([data-vibrancy]) .explorer {
    background: var(--vibrancy-tint, transparent);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  /* Windows Acrylic strength: a theme-coloured tint over the whole window
     (behind every island), driven by the Backdrop Opacity slider. Higher
     alpha = more opaque = less of the native Acrylic blur shows through. Must
     follow the [data-vibrancy] body rule above to win the equal-specificity
     tie. The native Acrylic tint colour is ignored on Windows 11, so this is
     the only reliable strength control. */
  :global([data-win-acrylic]) :global(body) {
    background: var(--win-acrylic-tint, transparent);
  }

  /* Windows Mica/Acrylic (#382): the macOS island tint (a white sheen over a
     lighter, translucent card) washes the UI out, but the previous fix —
     fully OPAQUE islands — meant the native backdrop only peeked through the
     chrome gaps and "transparency" read as broken. Islands now use the
     theme's dark SOLID colour at the Backdrop Opacity slider's strength
     (default 85%): dark enough not to wash out, translucent enough that the
     Mica/Acrylic material actually shows through the whole UI. Must follow
     the [data-vibrancy] var block to win the specificity tie. */
  :global([data-win-backdrop]) {
    --vibrancy-island-bg:
      linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.04) 0%,
        transparent 40%,
        rgba(0, 0, 0, 0.02) 100%
      ),
      color-mix(
        in srgb,
        var(--background-solid) calc(var(--win-backdrop-strength, 0.85) * 100%),
        transparent
      );
    --vibrancy-island-bg-structural:
      color-mix(
        in srgb,
        var(--background-solid) calc(var(--win-backdrop-strength, 0.85) * 88%),
        transparent
      );
  }

  /* No-blur mode: the island layout without any native transparency —
     macOS with blur off, and every platform (Linux) via floatingIslands
     (#277). Islands become opaque (blur over an opaque backdrop is wasted
     GPU), and the backdrop gets a quiet depth gradient — a whisper of the
     accent falling from the top, edges receding — so the islands still
     read as floating above a lit surface rather than painted on a flat
     wall. */
  :global([data-vibrancy-no-blur]) {
    --vibrancy-island-filter: none;
    --vibrancy-island-bg:
      linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.04) 0%,
        transparent 40%,
        rgba(0, 0, 0, 0.02) 100%
      ),
      linear-gradient(var(--background-card), var(--background-card)),
      var(--background-solid);
    --vibrancy-island-bg-structural:
      linear-gradient(
        var(--background-card-secondary, var(--background-card)),
        var(--background-card-secondary, var(--background-card))
      ),
      var(--background-solid);
  }

  :global([data-vibrancy-no-blur]) :global(body) {
    background: var(--background-solid);
    box-shadow: none;
  }

  :global([data-vibrancy-no-blur]) .explorer {
    background:
      radial-gradient(
        120% 90% at 50% -10%,
        color-mix(in srgb, var(--accent) 7%, transparent) 0%,
        transparent 55%
      ),
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--background-mica, var(--background-solid)) 97%, white) 0%,
        var(--background-mica, var(--background-solid)) 40%,
        color-mix(in srgb, var(--background-mica, var(--background-solid)) 95%, black) 100%
      );
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  :global([data-vibrancy]) .main-content {
    padding: 0 6px 6px 6px;
    gap: 8px;
  }

  /* Miller columns as left island (when sidebar hidden + vibrancy) */
  .miller-island {
    flex-shrink: 0;
    border-radius: var(--vibrancy-island-radius);
    background: var(--vibrancy-island-bg);
    box-shadow: var(--vibrancy-island-glow);
    overflow: hidden;
    display: flex;
    min-height: 0;
  }

  /* Preview pane as right island (vibrancy mode) */
  .preview-island {
    flex-shrink: 0;
    display: flex;
    min-height: 0;
  }

  /* Bottom/top dock: island is a column so the pane's inline height drives the
     island height and the pane stretches to full column width. */
  .preview-island.vertical {
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  :global([data-vibrancy]) .preview-island {
    border-radius: var(--vibrancy-island-radius);
    background: var(--vibrancy-island-bg);
    box-shadow: var(--vibrancy-island-glow);
    border: 1px solid var(--vibrancy-island-stroke);
    overflow: hidden;
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

  :global([data-vibrancy]) .pane-preview-stack {
    gap: 8px;
  }

  :global([data-vibrancy]) .theme-background-layer {
    display: none;
  }
</style>
