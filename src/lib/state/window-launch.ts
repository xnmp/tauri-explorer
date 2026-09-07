import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ExplorerSeed } from "$lib/domain/window-input";
import { directorySeedFitsBudget, normalizeDirectorySeed, windowSeedFitsBudget } from "$lib/domain/window-input";
import { formatWindowTitle } from "$lib/domain/tab-title";
import { explorerWindowAppearance } from "$lib/state/window-appearance";
import { requestWindowHandoff, type WindowHandoff } from "$lib/state/window-handoff";
import { resolveLaunchHomePath } from "$lib/state/window-title.svelte";
import { windowTabsManager, type TabSnapshot } from "$lib/state/window-tabs.svelte";
import { directorySeedKey, normalizeSnapshot, tabSeedKey } from "$lib/state/window-tabs-persistence";
import { savePersisted, removePersisted } from "$lib/state/persisted";
import { settingsStore } from "$lib/state/settings.svelte";
import type { ViewMode } from "$lib/state/types";
import { consumeWarmWindow } from "$lib/state/warm-window";

type WindowOptions = NonNullable<ConstructorParameters<typeof WebviewWindow>[1]>;
type CreationEvent = "tauri://created" | "tauri://error";

export interface LaunchWindow {
  once(event: CreationEvent, handler: () => void): Promise<() => void>;
  close(): Promise<void>;
}

/** Fresh construction and warm activation both name the accepted destination.
 * Only a fresh window exposes a handle for an ongoing tab tear-off gesture. */
export type WindowLaunchResult =
  | { kind: "fresh"; label: string; window: WebviewWindow }
  | { kind: "warm"; label: string };

export interface WindowLaunchDependencies {
  warmEnabled(): boolean;
  consumeWarm(path: string, viewMode?: ViewMode, at?: { x: number; y: number }): Promise<string | null>;
  captureDirectorySeed(path: string, viewMode?: ViewMode): ExplorerSeed | null;
  prepareGeometry(): Promise<{ x: number; y: number; width: number; height: number }>;
  createWindow(label: string, options: WindowOptions): WebviewWindow;
  requestHandoff(
    sourceWindow: string,
    targetWindow: string,
    dispatch: (handoff: WindowHandoff) => Promise<void>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<boolean>;
  sourceWindow(): string;
  homePath(): string | undefined;
  baseUrl(): string;
  appearance(title: string): Record<string, unknown>;
  save(key: string, value: unknown): void;
  remove(key: string): void;
  uuid(): string;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const defaultDependencies: WindowLaunchDependencies = {
  warmEnabled: () => settingsStore.warmWindow,
  consumeWarm: consumeWarmWindow,
  captureDirectorySeed: (path, viewMode) => {
    const explorer = windowTabsManager.getActiveExplorer();
    if (!explorer || explorer.currentPath !== path) return null;
    const now = Date.now();
    const normalized = normalizeDirectorySeed({
      currentPath: explorer.currentPath,
      entries: explorer.displayEntries,
      sortBy: explorer.sortBy,
      sortAscending: explorer.sortAscending,
      viewMode: viewMode ?? explorer.viewMode,
      ts: now,
    }, path, now);
    return normalized && directorySeedFitsBudget(normalized) ? normalized : null;
  },
  prepareGeometry: async () => {
    const win = getCurrentWindow();
    const [position, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    return { x: position.x, y: position.y, width: size.width, height: size.height };
  },
  createWindow: (label, options) => new WebviewWindow(label, options),
  requestHandoff: requestWindowHandoff,
  sourceWindow: () => windowTabsManager.windowLabel,
  homePath: resolveLaunchHomePath,
  baseUrl: () => window.location.origin + window.location.pathname,
  appearance: (title) => explorerWindowAppearance(title),
  save: savePersisted,
  remove: removePersisted,
  uuid: () => crypto.randomUUID(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

const CREATION_TIMEOUT_MS = 10_000;
const SEED_RETENTION_MS = 10_000;

function createCreationOwner(
  child: LaunchWindow,
  dependencies: WindowLaunchDependencies,
  onFailure: () => void,
  onLateCreated: () => void,
): { result: Promise<boolean>; expire(): void } {
  let expire = () => {};
  const result = new Promise<boolean>((resolve) => {
    let settled = false;
    let draining = false;
    const stops = new Set<() => void>();
    const cleanup = () => {
      for (const stop of stops) stop();
      stops.clear();
    };
    const finish = (created: boolean) => {
      if (draining) {
        if (created) onLateCreated();
        draining = false;
        cleanup();
        return;
      }
      if (settled) return;
      settled = true;
      dependencies.clearTimer(timer);
      cleanup();
      if (!created) onFailure();
      resolve(created);
    };
    const acquire = (event: CreationEvent, created: boolean) => {
      void child.once(event, () => finish(created)).then((stop) => {
        if (settled && !draining) stop();
        else stops.add(stop);
      }).catch(() => finish(false));
    };
    const timer = dependencies.setTimer(() => expire(), CREATION_TIMEOUT_MS);
    expire = () => {
      if (settled) return;
      settled = true;
      draining = true;
      dependencies.clearTimer(timer);
      onFailure();
      resolve(false);
      // Keep the created observer until native construction actually settles. A close sent
      // before native construction completes may legitimately find no window;
      // a late created event retries retirement instead of orphaning it.
    };
    // WebviewWindow stores these creation handlers synchronously before its
    // constructor's native invoke promise can settle.
    acquire("tauri://created", true);
    acquire("tauri://error", false);
  });
  return { result, expire: () => expire() };
}

/** Create a window launcher with injectable native/storage boundaries. */
export function createWindowLauncher(dependencies: WindowLaunchDependencies = defaultDependencies) {
  return async function openNewWindow(
    path: string,
    viewMode?: ViewMode,
    tabSnapshot?: TabSnapshot,
    at?: { x: number; y: number },
  ): Promise<WindowLaunchResult | null> {
    const normalizedTabSnapshot = tabSnapshot ? normalizeSnapshot(tabSnapshot) : null;
    if (tabSnapshot && !normalizedTabSnapshot) return null;
    if (!tabSnapshot && dependencies.warmEnabled()) {
      const label = await dependencies.consumeWarm(path, viewMode, at);
      if (label) return { kind: "warm", label };
    }

    const directorySeed = tabSnapshot ? null : dependencies.captureDirectorySeed(path, viewMode);
    const label = `explorer-${dependencies.uuid()}`;
    let geometry: Awaited<ReturnType<WindowLaunchDependencies["prepareGeometry"]>>;
    try {
      geometry = await dependencies.prepareGeometry();
    } catch {
      return null;
    }

    const params = new URLSearchParams({ path, focusAddressBar: "1" });
    const homePath = dependencies.homePath();
    if (homePath) params.set("home", homePath);
    if (viewMode) params.set("viewMode", viewMode);
    const options: WindowOptions = {
      url: `${dependencies.baseUrl()}?${params.toString()}`,
      width: geometry.width,
      height: geometry.height,
      x: at ? Math.round(at.x - 120) : geometry.x + 30,
      y: at ? Math.round(at.y - 16) : geometry.y + 30,
      ...dependencies.appearance(formatWindowTitle(path, homePath)),
    };

    let child: WebviewWindow | null = null;
    let seedKey: string | null = null;
    let seedTimer: ReturnType<typeof setTimeout> | null = null;
    let retired = false;
    const publishSeed = (key: string, value: unknown): boolean => {
      if (!windowSeedFitsBudget(value)) return false;
      seedKey = key;
      dependencies.save(key, value);
      seedTimer = dependencies.setTimer(() => dependencies.remove(key), SEED_RETENTION_MS);
      return true;
    };
    const clearOwnedSeed = () => {
      if (!seedKey) return;
      dependencies.remove(seedKey);
      seedKey = null;
      if (seedTimer) dependencies.clearTimer(seedTimer);
      seedTimer = null;
    };
    const retireChild = (retry = false) => {
      if (retired && !retry) return;
      retired = true;
      clearOwnedSeed();
      if (child) void child.close().catch(() => {});
    };
    const construct = (): { result: Promise<boolean>; expire(): void } | null => {
      try {
        child = dependencies.createWindow(label, options);
        return createCreationOwner(child, dependencies, retireChild, () => retireChild(true));
      } catch {
        retireChild();
        return null;
      }
    };

    if (!tabSnapshot) {
      if (directorySeed) publishSeed(directorySeedKey(label), { ...directorySeed, ts: Date.now() });
      const creation = construct();
      const created = creation ? await creation.result : false;
      return created && child ? { kind: "fresh", label, window: child } : null;
    }

    const cancellation = new AbortController();
    const creation = { current: null as ReturnType<typeof construct> };
    const adopted = dependencies.requestHandoff(
      dependencies.sourceWindow(),
      label,
      async (handoff) => {
        if (!publishSeed(tabSeedKey(label), { snapshot: normalizedTabSnapshot, ts: Date.now(), handoff })) {
          throw new Error("Tab snapshot exceeds the window handoff budget");
        }
        creation.current = construct();
        if (!creation.current) cancellation.abort();
        else void creation.current.result.then((created) => { if (!created) cancellation.abort(); });
      },
      CREATION_TIMEOUT_MS,
      cancellation.signal,
    );
    const wasAdopted = await adopted.catch(() => false);
    if (!wasAdopted) {
      retireChild();
      creation.current?.expire();
      return null;
    }
    clearOwnedSeed();
    const wasCreated = creation.current ? await creation.current.result : false;
    if (!wasCreated) return null;
    return child ? { kind: "fresh", label, window: child } : null;
  };
}

export const openNewWindow = createWindowLauncher();
