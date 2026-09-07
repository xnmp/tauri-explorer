/** Page-session composition. Window stores retain their own data lifetimes;
 * this owner acquires and retires the page's subscriptions and delayed work. */
import { isTauri } from "$lib/api/common";
import { E2E_WARM_WINDOW_PRIMING_DISABLED } from "$lib/domain/e2e-hooks";
import { planWindowLaunch } from "$lib/domain/window-launch-plan";
import { useNativeDropHandler } from "$lib/composables/use-native-drop-handler";
import { useFileWatchers } from "$lib/composables/use-file-watchers";
import { useWindowLifecycle } from "$lib/composables/use-window-lifecycle";
import { themeStore } from "./theme.svelte";
import { settingsStore } from "./settings.svelte";
import { pluginRegistry } from "$lib/plugins/registry.svelte";
import { startWindowStartup } from "./window-startup";
import { windowTabsManager } from "./window-tabs.svelte";
import { startWindowTitleSync } from "./window-title.svelte";
import { warmMode, runWarmWindow, spawnWarmWindow } from "./warm-window";
import { bookmarksStore } from "./bookmarks.svelte";
import { folderViewsStore } from "./folder-views.svelte";
import { manualHiddenStore } from "./manual-hidden.svelte";
import { gitStatusStore } from "./git-status.svelte";
import { initTabTransferListener } from "./tab-transfer";
import { startConfigWatch } from "./config-watch";
import { registerAllCommands } from "./command-definitions";
import { startWindowKeyboard } from "./window-keyboard";
import { keybindingsStore } from "./keybindings.svelte";
import { getCommand, executeCommand } from "./commands.svelte";
import { dialogStore } from "./dialogs.svelte";
import { terminalPanelStore } from "./terminal.svelte";
import { windowSizeStore } from "./window-size.svelte";
import { markStartup } from "./startup-timing";

export interface WindowSessionOptions {
  picker: boolean;
  homePath?: string;
  settingsReady(): void;
  commandsReady(): void;
}

export function startWindowSession(options: WindowSessionOptions) {
  const lifetime = new AbortController();
  const stops: Array<() => void> = [];
  let warmPrimeTimer: ReturnType<typeof setTimeout> | undefined;
  const reportError = (error: unknown) => console.error("Window session failed:", error);
  const dispose = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    clearTimeout(warmPrimeTimer);
    for (const stop of stops.reverse()) {
      try { stop(); } catch (error) { reportError(error); }
    }
    stops.length = 0;
  };

  try {
    markStartup("mount");
    void themeStore.initTheme().catch(reportError);
    const startup = startWindowStartup({
      loadSettings: () => settingsStore.init(),
      synchronizeTheme: () => themeStore.syncFromSettings(),
      publishSettingsReady: () => {
        markStartup("settings-ready");
        options.settingsReady();
      },
      initializePlugins: () => options.picker ? Promise.resolve() : pluginRegistry.initPlugins(),
      disposePlugins: () => options.picker ? Promise.resolve() : pluginRegistry.dispose(),
    });
    stops.push(() => { void startup.dispose().catch(reportError); });
    void startup.ready.catch(reportError);
    if (options.picker) return { dispose, markCoreReady() {} };

    if (isTauri()) stops.push(windowTabsManager.observeNativeClose());
    const mode = warmMode();
    const warmWindow = mode !== "off" ? runWarmWindow(mode === "measure") : null;
    if (warmWindow) stops.push(() => warmWindow.dispose());

    const plan = planWindowLaunch(window.location.search,
      (window as Window & { __LAUNCH_DATA__?: unknown }).__LAUNCH_DATA__, options.homePath);
    const watchers = useFileWatchers({ getAllExplorers: () => windowTabsManager.getAllExplorers() });
    stops.push(() => watchers.cleanup());
    watchers.setup();
    const tab = windowTabsManager.init(plan.initialPath, plan.skipRestore, plan.overridePath);
    stops.push(startWindowTitleSync(() => windowTabsManager.getActiveExplorer()?.currentPath, plan.homePath));
    if (plan.viewMode && tab) windowTabsManager.getActiveExplorer()?.setViewMode(plan.viewMode);

    void bookmarksStore.init().catch(reportError);
    void folderViewsStore.init().catch(reportError);
    void manualHiddenStore.init().catch(reportError);
    void gitStatusStore.initWatcherListener().catch(reportError);
    stops.push(initTabTransferListener());
    stops.push(startConfigWatch());

    // Literal flags prevent the bundler emitting this optional test module in
    // ordinary release assets. A retired session cannot install late hooks.
    if (import.meta.env.DEV || import.meta.env.VITE_E2E_HOOKS === "1") {
      void import("../../test-support/window-session-probe").then(({ startWindowSessionProbe }) => {
        startWindowSessionProbe(lifetime.signal, warmWindow?.ready);
      }).catch(reportError);
    }

    queueMicrotask(() => {
      if (lifetime.signal.aborted) return;
      registerAllCommands();
      markStartup("commands-ready");
      options.commandsReady();
    });
    let coreReady = false;
    const markCoreReady = () => {
      if (coreReady || lifetime.signal.aborted) return;
      coreReady = true;
      // The page reports configured commands + a loaded listing after its
      // paint opportunity. Optional warming cannot compete with that work.
      if (mode === "off" && !E2E_WARM_WINDOW_PRIMING_DISABLED) {
        warmPrimeTimer = setTimeout(() => {
          if (settingsStore.warmWindow) void spawnWarmWindow().catch(reportError);
        }, 1500);
      }
    };

    const getActiveExplorer = () => windowTabsManager.getActiveExplorer();
    const nativeDrop = useNativeDropHandler({ getActiveExplorer, refreshAllPanes: () => windowTabsManager.refreshAllPanes() });
    const lifecycle = useWindowLifecycle({ getActiveExplorer, saveTabs: () => windowTabsManager.save() });
    for (const service of [nativeDrop, lifecycle]) {
      stops.push(() => service.cleanup());
      service.setup();
    }
    stops.push(startWindowKeyboard(window, {
      bindings: keybindingsStore, getCommand, executeCommand, dialogs: dialogStore,
      terminal: { get enabled() { return settingsStore.enableTerminal; }, toggle: () => terminalPanelStore.toggle() },
      toggleDualPane: () => windowTabsManager.toggleDualPane(), getActiveExplorer,
    }));
    windowSizeStore.sync();
    window.addEventListener("resize", windowSizeStore.sync, { signal: lifetime.signal });
    return { dispose, markCoreReady };
  } catch (error) {
    dispose();
    throw error;
  }
}
