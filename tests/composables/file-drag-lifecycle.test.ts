import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ start: vi.fn(), listen: vi.fn(), emit: undefined as ((event: any) => void) | undefined,
  callbacks: new Map<number, (payload: unknown) => void>(), sequence: 0 }));
const transferFiles = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<object>(),
  invoke: (command: string, args: any) => {
    if (command !== "start_file_drag") return Promise.resolve(undefined);
    let index = 0;
    return native.start({ item: args.item, icon: args.image }, (message: unknown) => {
      native.callbacks.get(args.onEvent.id)?.({ index: index++, message });
    }, args.source);
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ listen: (_name: string, listener: (event: any) => void) => native.listen(listener) }) }));
vi.mock("$lib/state/drop-operations", async importOriginal => ({ ...await importOriginal<object>(), handleFileDropMany: transferFiles }));

import { createHtml5FileDrag } from "$lib/state/html5-file-drag.svelte";
import { useItemInteractions } from "$lib/composables/use-item-interactions.svelte";
import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
import { useNativeDropHandler } from "$lib/composables/use-native-drop-handler";
import { listenSidebarDragEnd } from "$lib/composables/use-sidebar-drag-end";
import { useDropTarget } from "$lib/composables/use-drop-target.svelte";
import { dragState } from "$lib/state/drag.svelte";
import { fileDropTargets } from "$lib/state/file-drop-targets.svelte";
import { dropElement } from "../helpers/drop-element";
import { toastStore } from "$lib/state/toast.svelte";
import { createExplorerState } from "$lib/state/explorer.svelte";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";

const paths = ["/source/z.png", "/source/a.png"];
const entry = { path: paths[1], name: "a.png", kind: "file", size: 1, modified: "" } as const;
let hit: HTMLElement;
let win: EventTarget;
let doc: EventTarget;
let sourceElements: WeakMap<DataTransfer, HTMLElement>;
const cleanup: (() => void | Promise<void>)[] = [];
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function payload(): DataTransfer {
  const values = new Map<string, string>();
  const data = { setData: (key: string, value: string) => values.set(key, value), getData: (key: string) => values.get(key) ?? "",
    get types() { return [...values.keys()]; }, effectAllowed: "none", dropEffect: "none" } as unknown as DataTransfer;
  sourceElements.set(data, dropElement()); return data;
}
function event(type: string, dt: DataTransfer, ctrlKey = false, target?: EventTarget): DragEvent {
  const value = Object.assign(new Event(type, { cancelable: true }), { dataTransfer: dt, clientX: 20, clientY: 30, ctrlKey, altKey: false });
  Object.defineProperty(value, "target", { value: target ?? (type === "dragstart" || type === "dragend" ? sourceElements.get(dt) : hit) });
  return value as DragEvent;
}
function emit(type: string, incoming = [...paths], copyModifier?: boolean): void {
  native.emit!({ payload: { type, paths: incoming, position: { x: 40, y: 60 }, copyModifier } });
}
function begin(ctrlKey = false) {
  const source = createHtml5FileDrag(); const dt = payload();
  win.dispatchEvent(event("dragstart", dt, ctrlKey));
  source.start(event("dragstart", dt, ctrlKey), { ...entry, paths: [...paths] });
  doc.dispatchEvent(event("dragstart", dt, ctrlKey));
  return { source, dt };
}
function modifiers(type: "keydown" | "keyup" | "dragover", ctrlKey: boolean, dt: DataTransfer) {
  win.dispatchEvent(event(type, dt, ctrlKey));
}
beforeEach(async () => {
  dragState.clear(); transferFiles.mockClear(); native.start.mockReset().mockResolvedValue(undefined); native.callbacks.clear();
  sourceElements = new WeakMap();
  native.listen.mockImplementation((listener: (event: any) => void) => { native.emit = listener; return Promise.resolve(vi.fn()); });
  hit = dropElement("entry-item directory", { "data-path": "/destination" });
  win = new EventTarget(); doc = new EventTarget();
  vi.stubGlobal("window", Object.assign(win, { __TAURI_INTERNALS__: {
    transformCallback: (callback: (payload: unknown) => void) => { const id = ++native.sequence; native.callbacks.set(id, callback); return id; },
    unregisterCallback: (id: number) => native.callbacks.delete(id),
  }, devicePixelRatio: 2 }));
  vi.stubGlobal("document", Object.assign(doc, { elementFromPoint: () => hit, documentElement: { style: { zoom: "150%" } } }));
  vi.stubGlobal("DataTransfer", function () { return payload(); });
  vi.stubGlobal("DragEvent", function (type: string, init: DragEventInit) {
    const { bubbles, cancelable, ...data } = init;
    return Object.assign(new Event(type, { bubbles, cancelable }), data);
  });
  hit.dispatchEvent = value => { Object.defineProperty(value, "target", { value: hit }); return win.dispatchEvent(value); };
  const service = useNativeDropHandler({ getActiveExplorer: () => ({ currentPath: "/destination", captureMutation: () => ({ current: () => true }) }) as any, refreshAllPanes: vi.fn() });
  service.setup(); cleanup.push(service.cleanup);
  cleanup.push(listenSidebarDragEnd({ quickAccess: () => undefined, isDragOver: () => false, reset: vi.fn() }));
  await flush();
});
afterEach(async () => {
  for (const call of native.start.mock.calls) call[1]?.({ result: "Cancelled" });
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  dragState.clear(); toastStore.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe("filesystem source to registered native/DOM listener lifecycle", () => {
  it("does not transfer an external drop through the inert Miller island into its covered pane", async () => {
    hit = dropElement("miller-island");
    vi.spyOn(dialogStore, "isPaneBlocked").mockReturnValue(true);
    emit("enter", ["/external/image.png"]); emit("drop", ["/external/image.png"]); await flush();
    expect(transferFiles).not.toHaveBeenCalled();
  });
  it("does not redirect a drop on covered pane A's exposed wrapper into active pane B", async () => {
    hit = dropElement("explorer-pane", { "data-pane-id": "a" });
    vi.spyOn(windowTabsManager, "activePaneId", "get").mockReturnValue("b");
    vi.spyOn(dialogStore, "isPaneBlocked").mockImplementation(paneId => paneId === "a");
    emit("enter", ["/external/image.png"]); emit("drop", ["/external/image.png"]); await flush();
    expect(transferFiles).not.toHaveBeenCalled();
  });
  it.each(["path", "pane", "registration", "detached"])("discards a deferred drop when destination %s changes", async change => {
    let reject!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attrs = { "data-current-path": "/destination", "data-pane-id": "b" };
    hit = dropElement("content", attrs);
    hit.dispatchEvent = value => { Object.defineProperty(value, "target", { value: hit }); return win.dispatchEvent(value); };
    const original = vi.fn(), replacement = vi.fn();
    const dispose = fileDropTargets.register(hit, original); cleanup.push(dispose);
    win.addEventListener("drop", e => {
      if (!e.defaultPrevented) return;
      const folder = useDropTarget({ onRefresh: vi.fn() });
      void folder.handleDrop(e as DragEvent, { ...entry, kind: "directory", path: attrs["data-current-path"] });
    });
    const { source, dt } = begin(); win.dispatchEvent(event("drop", dt)); source.end();
    if (change === "path") attrs["data-current-path"] = "/other";
    if (change === "pane") attrs["data-pane-id"] = "replacement";
    if (change === "registration") { dispose(); cleanup.push(fileDropTargets.register(hit, replacement)); }
    if (change === "detached") Object.defineProperty(hit, "isConnected", { value: false });
    reject(new Error("native unavailable")); await flush();
    expect(original).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled();
    expect(transferFiles).not.toHaveBeenCalled();
    expect(toastStore.toasts.some(toast => /drop.*cancel|destination.*chang/i.test(toast.message))).toBe(true);
  });

  it("does not replay a deferred listing drop into the pane's new directory", async () => {
    let reject!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const attrs = { "data-current-path": "/destination" };
    hit = dropElement("content", attrs);
    hit.dispatchEvent = value => { Object.defineProperty(value, "target", { value: hit }); return win.dispatchEvent(value); };
    const folder = useDropTarget({ onRefresh: vi.fn() });
    win.addEventListener("drop", e => { void folder.handleDrop(e as DragEvent, { ...entry, kind: "directory", path: attrs["data-current-path"] }); });
    const { source, dt } = begin(); win.dispatchEvent(event("drop", dt)); source.end();
    attrs["data-current-path"] = "/other";
    reject(new Error("native unavailable")); await flush();
    expect(transferFiles).not.toHaveBeenCalled();
    expect(toastStore.toasts.some(toast => /drop.*cancel|destination.*chang/i.test(toast.message))).toBe(true);
  });

  it.each(["round-trip navigation", "pane replacement", "reparenting", "modality"])("rejects deferred delivery after %s even when the destination path is unchanged", async change => {
    let reject!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const explorer = createExplorerState();
    await explorer.navigateTo("/home/user/Documents");
    cleanup.push(() => explorer.destroy());
    const lookup = vi.spyOn(windowTabsManager, "getExplorer").mockReturnValue(explorer);
    const attrs: Record<string, string> = { "data-pane-id": "b" };
    const owner = dropElement("explorer-pane", attrs);
    hit = dropElement("content", { "data-current-path": explorer.currentPath }, owner);
    hit.dispatchEvent = value => { Object.defineProperty(value, "target", { value: hit }); return win.dispatchEvent(value); };
    const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
    const { source, dt } = begin(); win.dispatchEvent(event("drop", dt)); source.end();
    if (change === "round-trip navigation") {
      await explorer.navigateTo("/home/user/Pictures");
      await explorer.navigateTo("/home/user/Documents");
    }
    if (change === "pane replacement") {
      const replacement = createExplorerState(); lookup.mockReturnValue(replacement);
      cleanup.push(() => replacement.destroy());
    }
    if (change === "reparenting") Object.assign(hit, { parentElement: dropElement("explorer-pane", { "data-pane-id": "b" }) });
    if (change === "modality") attrs.inert = "";
    reject(new Error("native unavailable")); await flush();
    expect(handler).not.toHaveBeenCalled(); expect(transferFiles).not.toHaveBeenCalled();
    expect(toastStore.toasts.some(toast => /drop.*cancel|destination.*chang/i.test(toast.message))).toBe(true);
  });
  it.each([
    ["breadcrumb", "crumb", false], ["listing background", "content", false], ["Miller background", "miller-col", true],
  ] as const)("preserves dev's copy policy on a %s for a former DOM source", async (_name, classes, copy) => {
    hit = dropElement(classes, { "data-path": "/destination", "data-current-path": "/destination" });
    begin(true); await flush(); emit("enter"); emit("drop"); await flush();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination", copy, expect.anything());
  });
  it.each(["unhandled", "file-row"])("a former DOM source has no implicit transfer onto %s", async kind => {
    hit = kind === "unhandled" ? dropElement() : dropElement("entry-item", {}, dropElement("content", { "data-current-path": "/destination" }));
    begin(true); await flush(); emit("enter"); emit("drop"); await flush();
    expect(transferFiles).not.toHaveBeenCalled();
  });
  it("Miller background permits dev's copy-within-source-directory operation", async () => {
    hit = dropElement("miller-col", { "data-path": "/source" });
    begin(false); await flush(); emit("enter"); emit("drop", paths, true); await flush();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/source", true, expect.anything());
  });
  it.each([true, false])("carries Miller/Recent copy intent through native handoff (Ctrl=%s)", async copying => {
    const { source, dt } = begin(copying); await flush();
    emit("enter"); emit("drop", [...paths].reverse()); await flush();
    doc.dispatchEvent(event("dragend", dt)); source.end();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination", copying, expect.objectContaining({ broadcastToOtherWindows: false }));
  });

  it.each(["keyboard", "dragover"] as const)("uses current %s modifiers when Ctrl is pressed after native drag start", async input => {
    const { dt } = begin(false); await flush(); emit("enter");
    modifiers(input === "keyboard" ? "keydown" : "dragover", true, dt);
    emit("drop"); await flush();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination", true, expect.anything());
  });

  it.each(["keyboard", "dragover"] as const)("uses current %s modifiers when Ctrl is released before native drop", async input => {
    const { dt } = begin(true); await flush(); emit("enter");
    modifiers(input === "keyboard" ? "keyup" : "dragover", false, dt);
    emit("drop"); await flush();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination", false, expect.anything());
  });

  it.each([true, false])("native drop-time modifiers override stale renderer state (Ctrl=%s)", async copying => {
    begin(!copying); await flush(); emit("enter"); emit("drop", paths, copying); await flush();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination", copying, expect.anything());
  });

  it("a pointer source handed to native honors drop-time Ctrl", async () => {
    Object.assign(doc, { createElement: () => ({ style: {}, remove: vi.fn() }), body: { appendChild: vi.fn() } });
    const source = usePointerDrag({ getExplorer: () => ({ getSelectedEntries: () => [entry], currentPath: "/source", refresh: vi.fn() }) as any });
    const down = Object.assign(new Event("mousedown", { cancelable: true }), { button: 0, clientX: 20, clientY: 30 });
    source.handlePointerDown(down as MouseEvent, entry, true);
    win.dispatchEvent(Object.assign(new Event("mousemove"), { clientX: -10, clientY: 30 }));
    await flush(); emit("enter", [entry.path]); emit("drop", [entry.path], true); await flush();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith([entry.path], "/destination", true, expect.anything());
  });

  it("a delayed DOM fallback cannot overwrite a successor native drag's modifiers", async () => {
    let reject!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const folder = useDropTarget({ onRefresh: vi.fn() });
    win.addEventListener("drop", e => { void folder.handleDrop(e as DragEvent, { ...entry, path: "/destination", kind: "directory" }); });
    const original = begin(false); win.dispatchEvent(event("drop", original.dt, false)); original.source.end();
    begin(true); await flush();
    reject(new Error("unavailable")); await flush();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination", false, expect.anything());
    emit("enter"); emit("drop"); await flush();
    expect(transferFiles).toHaveBeenLastCalledWith(paths, "/destination", true, expect.anything());
  });

  it.each([true, false])("DOM fallback uses drop-time Ctrl=%s after native start rejection", async copying => {
    native.start.mockRejectedValueOnce("unavailable");
    const { dt } = begin(!copying); await flush();
    win.dispatchEvent(event("drop", dt, copying));
    const target = useDropTarget({ onRefresh: vi.fn() });
    await target.handleDrop(event("drop", dt, copying), { ...entry, path: "/destination", kind: "directory" });
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination", copying, expect.anything());
  });

  it("preserves dev's Linux main-listing move policy even when Ctrl starts the drag", async () => {
    const interactions = useItemInteractions({ getExplorer: () => ({ getSelectedEntries: () => [entry], refresh: vi.fn() }) as any });
    const dt = payload(); interactions.handleDragStart(event("dragstart", dt, true), entry, true); await flush();
    emit("enter", [entry.path], true); emit("drop", [entry.path], true); await flush();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith([entry.path], "/destination", false, expect.anything());
  });

  it.each(["same-window", "cross-window"])("keeps source order and pane identity after sidebar capture dragend before native Enter (%s)", async route => {
    const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
    const { source, dt } = begin(); await flush();
    doc.dispatchEvent(event("dragend", dt)); source.end();
    if (route === "cross-window") {
      // A different renderer has no local source state and shares only storage.
      vi.resetModules();
      const receiver = await import("$lib/composables/use-native-drop-handler");
      const targets = await import("$lib/state/file-drop-targets.svelte");
      cleanup.push(targets.fileDropTargets.register(hit, handler));
      const service = receiver.useNativeDropHandler({ getActiveExplorer: () => undefined, refreshAllPanes: vi.fn() });
      service.setup(); cleanup.push(service.cleanup); await flush();
    }
    emit("enter", [...paths].reverse());
    native.start.mock.calls[0][1]({ result: "Dropped", cursorPos: { x: 20, y: 30 } }); await flush();
    emit("drop", [...paths].reverse()); await flush();
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
    expect(transferFiles).not.toHaveBeenCalled();
    expect(dragState.readCrossWindow()).toBeNull();
  });

  it.each(["same-window", "cross-window"])("uses the native event's source when source completion beats frontend Enter (%s)", async route => {
    const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
    const { source, dt } = begin(true); await flush();
    // The native boundary captures metadata before enqueuing receiver events.
    // Rust registry tests exercise that capture/retirement ordering directly.
    const queuedSource = structuredClone(native.start.mock.calls[0][2]);
    doc.dispatchEvent(event("dragend", dt)); source.end();
    if (route === "cross-window") {
      cleanup[0](); vi.resetModules();
      const receiver = await import("$lib/composables/use-native-drop-handler");
      const targets = await import("$lib/state/file-drop-targets.svelte");
      cleanup.push(targets.fileDropTargets.register(hit, handler));
      const service = receiver.useNativeDropHandler({ getActiveExplorer: () => undefined, refreshAllPanes: vi.fn() });
      service.setup(); cleanup.push(service.cleanup); await flush();
    }
    native.start.mock.calls[0][1]({ result: "Dropped", cursorPos: { x: 20, y: 30 } }); await flush();
    expect(dragState.readCrossWindow()).toBeNull();
    for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths: [...paths].reverse(), position: { x: 40, y: 60 }, source: queuedSource } });
    await flush(); expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
    expect(transferFiles).not.toHaveBeenCalled();
    // A later native external gesture with identical paths carries no source.
    for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths: [...paths].reverse(), position: { x: 40, y: 60 }, source: null } });
    await flush(); expect(handler).toHaveBeenLastCalledWith([...paths].reverse(), "external");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("allows the real directory DOM handler to copy after rejected native start", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    native.start.mockRejectedValueOnce(new Error("native unavailable"));
    const { source, dt } = begin(true); await flush();
    const folder = useDropTarget({ onRefresh: vi.fn() });
    win.addEventListener("drop", e => { void folder.handleDrop(e as DragEvent, { ...entry, path: "/destination", kind: "directory" }); });
    win.dispatchEvent(event("drop", dt, true)); await flush(); source.end();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination", true, expect.anything());
    expect(dragState.readCrossWindow()).toBeNull();
  });

  it("delivers a rejected native gesture to a plugin through DOM exactly once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    native.start.mockRejectedValueOnce(new Error("native unavailable"));
    const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
    const { source, dt } = begin(); await flush();
    win.dispatchEvent(event("drop", dt)); await flush(); source.end();
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane"); expect(transferFiles).not.toHaveBeenCalled();
  });

  it("suppresses duplicate DOM delivery only after a successful native handoff", async () => {
    const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
    const { source, dt } = begin(); await flush();
    win.dispatchEvent(event("drop", dt)); expect(handler).not.toHaveBeenCalled();
    emit("enter"); emit("drop"); await flush(); source.end();
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
  });

  it("suppresses a late built-in DOM drop after native delivery retires the source", async () => {
    const { dt } = begin(); await flush(); emit("enter"); emit("drop"); await flush();
    const folder = useDropTarget({ onRefresh: vi.fn() });
    win.addEventListener("drop", e => { void folder.handleDrop(e as DragEvent, { ...entry, path: "/destination", kind: "directory" }); });
    win.dispatchEvent(event("drop", dt)); await flush();
    expect(transferFiles).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])("decides a DOM drop racing native start exactly once (%s)", async result => {
    let accept!: () => void, reject!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
    const { source, dt } = begin();
    win.dispatchEvent(event("drop", dt)); doc.dispatchEvent(event("dragend", dt)); source.end();
    expect(handler).not.toHaveBeenCalled();
    if (result === "success") { accept(); await flush(); emit("enter"); emit("drop"); }
    else reject(new Error("native unavailable"));
    await flush();
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
    expect(transferFiles).not.toHaveBeenCalled();
  });

  it.each(["success", "failure", "failure-before-observer"])("coordinates a receiver-renderer DOM drop with the source's pending native start (%s)", async result => {
    let accept!: () => void, reject!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { source, dt } = begin(); cleanup[0]();
    vi.resetModules();
    const receiver = await import("$lib/composables/use-native-drop-handler");
    const targets = await import("$lib/state/file-drop-targets.svelte");
    const handler = vi.fn(); cleanup.push(targets.fileDropTargets.register(hit, handler));
    const service = receiver.useNativeDropHandler({ getActiveExplorer: () => undefined, refreshAllPanes: vi.fn() });
    service.setup(); cleanup.push(service.cleanup); await flush();
    // Model the browser storage boundary, including events from writes that
    // are subsequently superseded before the receiving event-loop runs.
    const write = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      write(key, value); win.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: value }));
    });
    if (result === "failure-before-observer") {
      const pendingSnapshot = localStorage.getItem("explorer-drag-data");
      doc.dispatchEvent(event("dragend", dt)); source.end();
      reject(new Error("native unavailable")); await flush();
      const read = localStorage.getItem.bind(localStorage); let reads = 0;
      // The receiver read pending immediately before failure retired the
      // record. Registration/re-read sees the newer storage state.
      vi.spyOn(localStorage, "getItem").mockImplementation(key => key === "explorer-drag-data" && ++reads <= 2 ? pendingSnapshot : read(key));
      win.dispatchEvent(event("drop", dt));
    } else {
      win.dispatchEvent(event("drop", dt)); doc.dispatchEvent(event("dragend", dt)); source.end();
      expect(handler).not.toHaveBeenCalled();
      if (result === "success") { accept(); await flush(); emit("enter"); emit("drop"); }
      else reject(new Error("native unavailable"));
    }
    await flush();
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
    expect(transferFiles).not.toHaveBeenCalled();
  });

  it("disposing the receiver abandons a deferred DOM drop instead of replaying into detached UI", async () => {
    let reject!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
    const { source, dt } = begin(); win.dispatchEvent(event("drop", dt));
    cleanup[0](); doc.dispatchEvent(event("dragend", dt)); source.end();
    reject(new Error("native unavailable")); await flush();
    expect(handler).not.toHaveBeenCalled(); expect(transferFiles).not.toHaveBeenCalled();
    expect(dragState.readCrossWindow()).toBeNull();
  });

  it("a delayed built-in fallback retires its own source and preserves a successor's failed-native DOM fallback", async () => {
    let rejectOriginal!: (error: Error) => void, rejectSuccessor!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { rejectOriginal = fail; }))
      .mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { rejectSuccessor = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const folder = useDropTarget({ onRefresh: vi.fn() });
    win.addEventListener("drop", e => { void folder.handleDrop(e as DragEvent, { ...entry, path: "/destination", kind: "directory" }); });
    const original = begin(); win.dispatchEvent(event("drop", original.dt)); original.source.end();
    const successor = createHtml5FileDrag(), dt = payload();
    successor.start(event("dragstart", dt), { path: "/successor.png", name: "successor.png", kind: "file" });
    doc.dispatchEvent(event("dragstart", dt));
    rejectOriginal(new Error("original native start failed")); await flush();
    expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination", false, expect.anything());
    doc.dispatchEvent(event("dragend", original.dt));
    rejectSuccessor(new Error("successor native start failed")); await flush();
    expect(dragState.current?.path).toBe("/successor.png");
    const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
    win.dispatchEvent(event("drop", dt)); await flush(); successor.end();
    expect(handler).toHaveBeenCalledExactlyOnceWith(["/successor.png"], "pane");
    expect(dragState.current).toBeNull();
  });

  it("keeps a successor browser gesture when sidebar capture receives the old dragend", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    const handler = vi.fn(() => dragState.start({ path: "/successor", name: "successor", kind: "directory" }));
    cleanup.push(fileDropTargets.register(hit, handler));
    const { source, dt } = begin();
    win.dispatchEvent(event("drop", dt)); await flush();
    const protectedTransfer = { getData: () => "", types: dt.types } as unknown as DataTransfer;
    doc.dispatchEvent(event("dragend", protectedTransfer, false, sourceElements.get(dt))); source.end();
    expect(dragState.current?.path).toBe("/successor");
    expect(dragState.readCrossWindow()?.path).toBe("/successor");
  });

  it("binds protected dragend to its source node even after a different source starts a DOM drag", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    const original = begin();
    const successor = createHtml5FileDrag(), dt = payload();
    const handler = vi.fn(() => {
      successor.start(event("dragstart", dt), { path: "/successor.png", name: "successor.png", kind: "file" });
      doc.dispatchEvent(event("dragstart", dt));
    });
    cleanup.push(fileDropTargets.register(hit, handler));
    win.dispatchEvent(event("drop", original.dt)); await flush();
    const protectedTransfer = { getData: () => "", types: original.dt.types } as unknown as DataTransfer;
    doc.dispatchEvent(event("dragend", protectedTransfer, false, sourceElements.get(original.dt))); original.source.end();
    expect(dragState.current?.path).toBe("/successor.png");
    expect(dragState.readCrossWindow()?.path).toBe("/successor.png");
    successor.end();
  });
});
