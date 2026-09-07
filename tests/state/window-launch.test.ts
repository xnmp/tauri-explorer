import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { ExplorerSeed } from "$lib/domain/window-input";
import {
  createWindowLauncher,
  type LaunchWindow,
  type WindowLaunchDependencies,
} from "$lib/state/window-launch";
import type { WindowHandoff } from "$lib/state/window-handoff";
import type { PersistedNode, TabSnapshot } from "$lib/state/window-tabs-persistence";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

class FakeWindow implements LaunchWindow {
  handlers = new Map<string, () => void>();
  stops: ReturnType<typeof vi.fn>[] = [];
  close = vi.fn(async () => {});
  once: LaunchWindow["once"] = vi.fn(async (event: "tauri://created" | "tauri://error", handler: () => void) => {
    this.handlers.set(event, handler);
    const stop = vi.fn(() => { this.handlers.delete(event); });
    this.stops.push(stop);
    return stop;
  });
  emit(event: "tauri://created" | "tauri://error") { this.handlers.get(event)?.(); }
}

const seed = (path: string, name: string): ExplorerSeed => ({
  currentPath: path,
  entries: [{ name, path: `${path}/${name}`, kind: "file", size: 1, modified: "now" }],
  sortBy: "name",
  sortAscending: true,
  viewMode: "details",
});

function fixture(options: {
  seeds?: Array<ExplorerSeed | null>;
  prepare?: () => Promise<{ x: number; y: number; width: number; height: number }>;
  construct?: (label: string) => FakeWindow;
  handoff?: WindowLaunchDependencies["requestHandoff"];
  warm?: boolean;
  consumeWarm?: () => Promise<string | null>;
} = {}) {
  const storage = new Map<string, unknown>();
  const windows: Array<{ label: string; window: FakeWindow }> = [];
  const seeds = [...(options.seeds ?? [null])];
  let id = 0;
  const dependencies: WindowLaunchDependencies = {
    warmEnabled: () => options.warm ?? false,
    consumeWarm: vi.fn(options.consumeWarm ?? (async () => null)),
    captureDirectorySeed: vi.fn(() => seeds.shift() ?? null),
    prepareGeometry: vi.fn(options.prepare ?? (async () => ({ x: 1, y: 2, width: 800, height: 600 }))),
    createWindow: vi.fn((label) => {
      const window = options.construct?.(label) ?? new FakeWindow();
      windows.push({ label, window });
      return window as unknown as WebviewWindow;
    }),
    requestHandoff: options.handoff ?? (async (_source, _target, dispatch) => {
      await dispatch({ sourceWindow: "source", requestId: "request" });
      return true;
    }),
    sourceWindow: () => "source",
    homePath: () => "/home",
    baseUrl: () => "http://localhost/",
    appearance: () => ({}),
    save: vi.fn((key, value) => storage.set(key, value)),
    remove: vi.fn((key) => storage.delete(key)),
    uuid: () => `id-${++id}`,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (timer) => clearTimeout(timer),
  };
  return { open: createWindowLauncher(dependencies), dependencies, storage, windows };
}

afterEach(() => vi.useRealTimers());

describe("window launch owner", () => {
  it("gives simultaneous same-path children independent directory seeds", async () => {
    const f = fixture({ seeds: [seed("/same", "first"), seed("/same", "second")] });
    const first = f.open("/same");
    const second = f.open("/same");
    await vi.waitFor(() => expect(f.windows).toHaveLength(2));
    expect([...f.storage.keys()].sort()).toEqual(["dir-seed:explorer-id-1", "dir-seed:explorer-id-2"]);
    expect((f.storage.get("dir-seed:explorer-id-1") as { entries: Array<{ name: string }> }).entries[0].name).toBe("first");
    expect((f.storage.get("dir-seed:explorer-id-2") as { entries: Array<{ name: string }> }).entries[0].name).toBe("second");
    f.windows[0].window.emit("tauri://created");
    f.windows[1].window.emit("tauri://created");
    expect(await first).toEqual({ kind: "fresh", label: f.windows[0].label, window: f.windows[0].window });
    expect(await second).toEqual({ kind: "fresh", label: f.windows[1].label, window: f.windows[1].window });
  });

  it("does not publish a seed when geometry preparation fails", async () => {
    const f = fixture({ seeds: [seed("/repo", "a")], prepare: async () => { throw new Error("position"); } });
    await expect(f.open("/repo")).resolves.toBeNull();
    expect(f.dependencies.save).not.toHaveBeenCalled();
    expect(f.dependencies.createWindow).not.toHaveBeenCalled();
  });

  it("cleans its seed when construction throws", async () => {
    const f = fixture({
      seeds: [seed("/repo", "a")],
      construct: () => { throw new Error("constructor"); },
    });
    await expect(f.open("/repo")).resolves.toBeNull();
    expect(f.storage.size).toBe(0);
    expect(f.dependencies.remove).toHaveBeenCalledWith("dir-seed:explorer-id-1");
  });

  it("waits for created and releases both native listeners on success", async () => {
    const f = fixture({ seeds: [seed("/repo", "a")] });
    let resolved = false;
    const opening = f.open("/repo").then((result) => { resolved = true; return result; });
    await vi.waitFor(() => expect(f.windows).toHaveLength(1));
    expect(resolved).toBe(false);
    f.windows[0].window.emit("tauri://created");
    expect(await opening).toEqual({ kind: "fresh", label: f.windows[0].label, window: f.windows[0].window });
    await vi.waitFor(() => expect(f.windows[0].window.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true));
  });

  it("cleans seed, listeners, and child after asynchronous native error", async () => {
    const f = fixture({ seeds: [seed("/repo", "a")] });
    const opening = f.open("/repo");
    await vi.waitFor(() => expect(f.windows).toHaveLength(1));
    f.windows[0].window.emit("tauri://error");
    await expect(opening).resolves.toBeNull();
    expect(f.storage.size).toBe(0);
    expect(f.windows[0].window.close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.windows[0].window.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true));
  });

  it("retires late listener acquisitions after creation timeout", async () => {
    vi.useFakeTimers();
    const lateStops = [vi.fn(), vi.fn()];
    const createdAcquisition = deferred<() => void>();
    const errorAcquisition = deferred<() => void>();
    const handlers: Partial<Record<"tauri://created" | "tauri://error", () => void>> = {};
    const child = new FakeWindow();
    child.once = vi.fn<LaunchWindow["once"]>((event, handler): Promise<() => void> => {
      handlers[event] = handler;
      return event === "tauri://created" ? createdAcquisition.promise : errorAcquisition.promise;
    });
    const f = fixture({ seeds: [seed("/repo", "a")], construct: () => child });
    const opening = f.open("/repo");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(opening).resolves.toBeNull();
    // Listener ownership follows the still-pending native creation task.
    // Its eventual error terminates the drain; acquisitions resolving even
    // later must retire themselves immediately.
    await vi.advanceTimersByTimeAsync(20_000);
    handlers["tauri://error"]!();
    createdAcquisition.resolve(lateStops[0]);
    errorAcquisition.resolve(lateStops[1]);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateStops[0]).toHaveBeenCalledOnce();
    expect(lateStops[1]).toHaveBeenCalledOnce();
    expect(f.storage.size).toBe(0);
    expect(lateStops).toHaveLength(2);
  });

  it("retries retirement when creation arrives after the initial timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeWindow();
    const f = fixture({ seeds: [seed("/repo", "a")], construct: () => child });
    const opening = f.open("/repo");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(opening).resolves.toBeNull();
    expect(child.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    child.emit("tauri://created");
    await Promise.resolve();
    expect(child.close).toHaveBeenCalledTimes(2);
    expect(child.stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  });

  it("does not allocate a fresh window or seed when a warm window accepts", async () => {
    const f = fixture({ warm: true, consumeWarm: async () => "explorer-warm-ready", seeds: [seed("/repo", "a")] });
    await expect(f.open("/repo")).resolves.toEqual({ kind: "warm", label: "explorer-warm-ready" });
    expect(f.dependencies.captureDirectorySeed).not.toHaveBeenCalled();
    expect(f.dependencies.prepareGeometry).not.toHaveBeenCalled();
    expect(f.dependencies.createWindow).not.toHaveBeenCalled();
    expect(f.dependencies.save).not.toHaveBeenCalled();
  });

  it("rejects an oversized normalized tab snapshot before creating a child", async () => {
    const hugePath = `/${"x".repeat(32_000)}`;
    let layout: PersistedNode = { type: "leaf", id: "p0", path: hugePath };
    for (let index = 1; index < 40; index += 1) {
      layout = {
        type: "split", id: `s${index}`, direction: "row", ratio: 0.5,
        first: layout,
        second: { type: "leaf", id: `p${index}`, path: hugePath },
      };
    }
    const snapshot: TabSnapshot = {
      path: "/repo",
      tab: { id: "tab", kind: "explorer", layout, activePaneId: "p0" },
    };
    const f = fixture();
    await expect(f.open("/repo", undefined, snapshot)).resolves.toBeNull();
    expect(f.dependencies.save).not.toHaveBeenCalled();
    expect(f.dependencies.createWindow).not.toHaveBeenCalled();
  });

  it("requires both native creation and the tear-off acknowledgement", async () => {
    const ack = deferred<boolean>();
    let handoff: WindowHandoff | null = null;
    const f = fixture({ handoff: async (_source, _target, dispatch) => {
      handoff = { sourceWindow: "source", requestId: "ack" };
      await dispatch(handoff);
      return ack.promise;
    } });
    let resolved = false;
    const opening = f.open("/repo", undefined, { path: "/repo" }).then((result) => { resolved = true; return result; });
    await vi.waitFor(() => expect(f.windows).toHaveLength(1));
    expect([...f.storage.keys()]).toEqual(["tab-seed:explorer-id-1"]);
    expect((f.storage.get("tab-seed:explorer-id-1") as { handoff: WindowHandoff }).handoff).toEqual(handoff);
    ack.resolve(true);
    await Promise.resolve();
    expect(resolved).toBe(false);
    f.windows[0].window.emit("tauri://created");
    expect(await opening).toEqual({ kind: "fresh", label: f.windows[0].label, window: f.windows[0].window });
    expect(f.storage.has("tab-seed:explorer-id-1")).toBe(false);
  });

  it("also remains pending when creation precedes the tear-off acknowledgement", async () => {
    const ack = deferred<boolean>();
    const f = fixture({ handoff: async (_source, _target, dispatch) => {
      await dispatch({ sourceWindow: "source", requestId: "ack" });
      return ack.promise;
    } });
    let resolved = false;
    const opening = f.open("/repo", undefined, { path: "/repo" }).then((result) => { resolved = true; return result; });
    await vi.waitFor(() => expect(f.windows).toHaveLength(1));
    f.windows[0].window.emit("tauri://created");
    await Promise.resolve();
    expect(resolved).toBe(false);
    ack.resolve(true);
    expect(await opening).toEqual({ kind: "fresh", label: f.windows[0].label, window: f.windows[0].window });
  });

  it("an error after tear-off acknowledgement still fails and cleans ownership", async () => {
    const ack = deferred<boolean>();
    const f = fixture({ handoff: async (_source, _target, dispatch) => {
      await dispatch({ sourceWindow: "source", requestId: "ack" });
      return ack.promise;
    } });
    const opening = f.open("/repo", undefined, { path: "/repo" });
    await vi.waitFor(() => expect(f.windows).toHaveLength(1));
    ack.resolve(true);
    f.windows[0].window.emit("tauri://error");
    await expect(opening).resolves.toBeNull();
    expect(f.storage.size).toBe(0);
    expect(f.windows[0].window.close).toHaveBeenCalled();
  });

  it("returns immediately on adoption timeout and retires a later-created child", async () => {
    const f = fixture({ handoff: async (_source, _target, dispatch) => {
      await dispatch({ sourceWindow: "source", requestId: "expired" });
      return false;
    } });
    const opening = f.open("/repo", undefined, { path: "/repo" });
    await vi.waitFor(() => expect(f.windows).toHaveLength(1));
    await expect(opening).resolves.toBeNull();
    expect(f.windows[0].window.close).toHaveBeenCalledOnce();
    f.windows[0].window.emit("tauri://created");
    await Promise.resolve();
    expect(f.windows[0].window.close).toHaveBeenCalledTimes(2);
    expect(f.storage.size).toBe(0);
  });
});
