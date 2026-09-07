import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWindowSession } from "$lib/state/window-session";

const f = vi.hoisted(() => ({
  settings: vi.fn<() => Promise<void>>(), initTabs: vi.fn(() => ({})), view: vi.fn(),
  commands: vi.fn(), spawn: vi.fn(async () => {}), plugins: vi.fn(async () => {}), disposePlugins: vi.fn(async () => {}),
  title: vi.fn(), stopTitle: vi.fn(), nativeClose: vi.fn(), stopNativeClose: vi.fn(),
  setupDrop: vi.fn(), cleanupDrop: vi.fn(), setupWatch: vi.fn(), cleanupWatch: vi.fn(),
  setupLifecycle: vi.fn(), cleanupLifecycle: vi.fn(), stopKeyboard: vi.fn(),
  config: vi.fn(), stopConfig: vi.fn(), transfer: vi.fn(), stopTransfer: vi.fn(),
  syncSize: vi.fn(), probe: vi.fn(), nativeSession: vi.fn(async () => "session"),
  mode: "off", warmEnabled: true,
}));
vi.mock("$lib/api/common", () => ({ isTauri: () => true }));
vi.mock("$lib/api/native-resource-session", () => ({
  getNativeResourceSession: f.nativeSession,
}));
vi.mock("$lib/domain/e2e-hooks", () => ({ E2E_WARM_WINDOW_PRIMING_DISABLED: false }));
vi.mock("$lib/state/theme.svelte", () => ({ themeStore: { initTheme: async () => {}, syncFromSettings() {} } }));
vi.mock("$lib/state/settings.svelte", () => ({ settingsStore: { init: f.settings, get warmWindow() { return f.warmEnabled; } } }));
vi.mock("$lib/plugins/registry.svelte", () => ({ pluginRegistry: { initPlugins: f.plugins, dispose: f.disposePlugins } }));
vi.mock("$lib/state/window-tabs.svelte", () => ({ windowTabsManager: { init: f.initTabs, observeNativeClose: f.nativeClose,
  getActiveExplorer: () => ({ currentPath: "/work", setViewMode: f.view }) } }));
vi.mock("$lib/state/window-title.svelte", () => ({ startWindowTitleSync: f.title }));
vi.mock("$lib/state/warm-window", () => ({ warmMode: () => f.mode, spawnWarmWindow: f.spawn,
  runWarmWindow: () => ({ ready: Promise.resolve(true), dispose() {} }) }));
vi.mock("$lib/state/bookmarks.svelte", () => ({ bookmarksStore: { init: async () => {} } }));
vi.mock("$lib/state/folder-views.svelte", () => ({ folderViewsStore: { init: async () => {} } }));
vi.mock("$lib/state/manual-hidden.svelte", () => ({ manualHiddenStore: { init: async () => {} } }));
vi.mock("$lib/state/git-status.svelte", () => ({ gitStatusStore: { initWatcherListener: async () => {} } }));
vi.mock("$lib/state/tab-transfer", () => ({ initTabTransferListener: f.transfer }));
vi.mock("$lib/state/config-watch", () => ({ startConfigWatch: f.config }));
vi.mock("$lib/state/command-definitions", () => ({ registerAllCommands: f.commands }));
vi.mock("$lib/state/window-keyboard", () => ({ startWindowKeyboard: () => f.stopKeyboard }));
vi.mock("$lib/state/keybindings.svelte", () => ({ keybindingsStore: {} }));
vi.mock("$lib/state/commands.svelte", () => ({ getCommand() {}, executeCommand() {} }));
vi.mock("$lib/state/dialogs.svelte", () => ({ dialogStore: {} }));
vi.mock("$lib/state/terminal.svelte", () => ({ terminalPanelStore: {} }));
vi.mock("$lib/state/window-size.svelte", () => ({ windowSizeStore: { sync: f.syncSize } }));
vi.mock("$lib/state/startup-timing", () => ({ markStartup() {} }));
vi.mock("$lib/composables/use-native-drop-handler", () => ({ useNativeDropHandler: () => ({ setup: f.setupDrop, cleanup: f.cleanupDrop }) }));
vi.mock("$lib/composables/use-file-watchers", () => ({ useFileWatchers: () => ({ setup: f.setupWatch, cleanup: f.cleanupWatch }) }));
vi.mock("$lib/composables/use-window-lifecycle", () => ({ useWindowLifecycle: () => ({ setup: f.setupLifecycle, cleanup: f.cleanupLifecycle }) }));
vi.mock("../../src/test-support/window-session-probe", () => ({ startWindowSessionProbe: f.probe }));

let resolveSettings: () => void;
let host: EventTarget;
const options = () => ({ picker: false, homePath: "/home/me", settingsReady: vi.fn(), commandsReady: vi.fn() });
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  f.mode = "off"; f.warmEnabled = true;
  f.settings.mockImplementation(() => new Promise(resolve => { resolveSettings = resolve; }));
  f.title.mockReturnValue(f.stopTitle); f.nativeClose.mockReturnValue(f.stopNativeClose);
  f.config.mockReturnValue(f.stopConfig); f.transfer.mockReturnValue(f.stopTransfer);
  f.setupWatch.mockReset(); f.cleanupDrop.mockReset();
  f.nativeSession.mockResolvedValue("session");
  host = Object.assign(new EventTarget(), { location: { search: "?path=%2Fchild&viewMode=tiles" } });
  vi.stubGlobal("window", host);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("page session ownership", () => {
  it("starts requested navigation synchronously without waiting for settings or plugins", async () => {
    const callbacks = options();
    const session = startWindowSession(callbacks);
    expect(f.setupWatch.mock.invocationCallOrder[0]).toBeLessThan(
      f.initTabs.mock.invocationCallOrder[0],
    );
    expect(f.initTabs).toHaveBeenCalledWith("/child", true, undefined);
    expect(f.view).toHaveBeenCalledWith("tiles");
    expect(callbacks.settingsReady).not.toHaveBeenCalled();
    expect(f.plugins).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(callbacks.commandsReady).toHaveBeenCalledOnce();
    session.dispose();
    resolveSettings();
    await Promise.resolve();
    expect(f.plugins).not.toHaveBeenCalled();
  });

  it("retires queued command registration and readiness publication on teardown", async () => {
    const callbacks = options();
    const session = startWindowSession(callbacks);
    session.dispose();
    await Promise.resolve();
    expect(f.commands).not.toHaveBeenCalled();
    expect(callbacks.commandsReady).not.toHaveBeenCalled();
  });

  it("does not prime optional windows before the foreground reports core readiness", async () => {
    const session = startWindowSession(options());
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.nativeSession).not.toHaveBeenCalled();
    resolveSettings();
    await Promise.resolve();
    session.markCoreReady();
    session.markCoreReady();
    await Promise.resolve();
    expect(f.nativeSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.spawn).toHaveBeenCalledOnce();
    session.dispose();
  });

  it("cancels a pending warm prime and every acquired page listener", async () => {
    const session = startWindowSession(options());
    session.markCoreReady();
    session.dispose(); session.dispose(); session.markCoreReady();
    host.dispatchEvent(new Event("resize"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.syncSize).toHaveBeenCalledOnce();
    for (const stop of [f.stopTitle, f.stopNativeClose, f.cleanupDrop, f.cleanupWatch,
      f.cleanupLifecycle, f.stopKeyboard, f.stopTransfer, f.stopConfig]) expect(stop).toHaveBeenCalledOnce();
  });

  it("rolls back earlier services when a later setup fails, even if cleanup also fails", async () => {
    f.setupWatch.mockImplementation(() => { throw new Error("watch setup"); });
    f.cleanupDrop.mockImplementation(() => { throw new Error("drop cleanup"); });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => startWindowSession(options())).toThrow("watch setup");
    expect(f.cleanupWatch).toHaveBeenCalledOnce();
    expect(f.initTabs).not.toHaveBeenCalled();
    expect(f.stopTitle).not.toHaveBeenCalled();
    expect(f.stopNativeClose).toHaveBeenCalledOnce();
    resolveSettings();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.plugins).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it.each(["park", "measure", "disabled"])("never primes another window for %s sessions", async (mode) => {
    f.mode = mode === "disabled" ? "off" : mode;
    f.warmEnabled = mode !== "disabled";
    const session = startWindowSession(options());
    resolveSettings(); await Promise.resolve();
    session.markCoreReady();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.spawn).not.toHaveBeenCalled();
    session.dispose();
  });

  it("keeps picker sessions free of explorer services and plugin activation", async () => {
    const session = startWindowSession({ ...options(), picker: true });
    resolveSettings(); await Promise.resolve();
    session.markCoreReady();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.initTabs).not.toHaveBeenCalled();
    expect(f.setupWatch).not.toHaveBeenCalled();
    expect(f.commands).not.toHaveBeenCalled();
    expect(f.plugins).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.nativeSession).not.toHaveBeenCalled();
    session.dispose();
  });
});
