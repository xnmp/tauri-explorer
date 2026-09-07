import { extractError } from "$lib/api/common";
import { logFrontendDiagnostic } from "$lib/api/frontend-log";
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
  once(event: CreationEvent, handler: (event?: { payload?: unknown }) => void): Promise<() => void>;
  destroy(): Promise<void>;
}

/** Fresh construction and warm activation both name the accepted destination.
 * Only a fresh window exposes a handle for an ongoing tab tear-off gesture. */
export type WindowLaunchResult =
  | { kind: "fresh"; label: string; window: WebviewWindow }
  | { kind: "warm"; label: string };

export interface WindowLaunchFailure {
  label: string;
  phase: "geometry" | "construct" | "listener" | "native" | "timeout" | "retire";
  error?: unknown;
}

export interface WindowLaunchDependencies {
  reportFailure?(failure: WindowLaunchFailure): void;
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
  reportFailure: ({ label, phase, error }) => logFrontendDiagnostic("window launch failed", {
    label, phase, error: error === undefined ? null : extractError(error),
  }),
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
  onFailure: (failure: Omit<WindowLaunchFailure, "label">) => void,
  onCreated: () => void,
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
    const finish = (created: boolean, failure: Omit<WindowLaunchFailure, "label">) => {
      if (settled && !draining) return;
      // A JS window handle is only a label proxy. Native success is the first
      // point at which this invocation owns a window, including after timeout.
      if (created) onCreated();
      if (draining) {
        if (!created) onFailure(failure); // Retain a native error arriving after timeout.
        draining = false;
        cleanup();
        return;
      }
      settled = true;
      dependencies.clearTimer(timer);
      cleanup();
      if (!created) onFailure(failure);
      resolve(created);
    };
    const failPending = (failure: Omit<WindowLaunchFailure, "label">) => {
      if (settled && !draining) return;
      settled = true;
      draining = true;
      dependencies.clearTimer(timer);
      onFailure(failure);
      resolve(false);
      // Native construction cannot be cancelled. Keep surviving observers so
      // a late success can retire the owned child without touching other labels.
    };
    const acquire = (event: CreationEvent, created: boolean) => {
      try {
        void child.once(event, (value) => finish(created, { phase: "native", error: value?.payload })).then((stop) => {
          if (settled && !draining) stop();
          else stops.add(stop);
        }).catch((error) => failPending({ phase: "listener", error }));
      } catch (error) {
        failPending({ phase: "listener", error });
      }
    };
    const timer = dependencies.setTimer(() => expire(), CREATION_TIMEOUT_MS);
    expire = () => {
      if (settled) return;
      failPending({ phase: "timeout" });
    };
    // WebviewWindow stores these creation handlers synchronously before its
    // constructor's native invoke promise can settle.
    acquire("tauri://created", true);
    acquire("tauri://error", false);
  });
  return { result, expire: () => expire() };
}

/** Create a window launcher with injectable native/storage boundaries. */
export function createWindowLauncher(overrides: Partial<WindowLaunchDependencies> = {}) {
  const dependencies: WindowLaunchDependencies = { ...defaultDependencies, ...overrides };
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
    } catch (error) {
      dependencies.reportFailure?.({ label, phase: "geometry", error });
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
    let owned = false;
    let destroyRequested = false;
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
    const retireChild = () => {
      retired = true;
      clearOwnedSeed();
      if (!child || !owned || destroyRequested) return;
      destroyRequested = true;
      // Rollback must not depend on the rejected child's close-request handler.
      void child.destroy().catch((error) => {
        dependencies.reportFailure?.({ label, phase: "retire", error });
      });
    };
    const construct = (): { result: Promise<boolean>; expire(): void } | null => {
      try {
        child = dependencies.createWindow(label, options);
        return createCreationOwner(child, dependencies, (failure) => {
          retireChild();
          dependencies.reportFailure?.({ label, ...failure });
        }, () => {
          owned = true;
          if (retired) retireChild();
        });
      } catch (error) {
        dependencies.reportFailure?.({ label, phase: "construct", error });
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
