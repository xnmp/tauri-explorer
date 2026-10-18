import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dropClockCases } from "../helpers/drop-policy";
vi.mock("$lib/state/drag-clock", async actual => ({ ...await actual<object>(), dragClock: {
  initialize: async () => {}, ready: true,
  stamp: () => ({ clockId: `browser:${performance.timeOrigin}`, at: Math.floor(performance.timeOrigin + performance.now()), uncertainty: 0 }),
} }));

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
import { modalOwnership } from "$lib/state/modal-ownership.svelte";
import { highlightTargetAtPoint } from "$lib/composables/use-native-drop-target.svelte";
import { dropIntoDirectory } from "$lib/composables/use-dom-directory-drop";

const paths = ["/source/z.png", "/source/a.png"];
const entry = { path: paths[1], name: "a.png", kind: "file", size: 1, modified: "" } as const;
let hit: HTMLElement;
let win: EventTarget;
let doc: EventTarget;
let sourceElements: WeakMap<DataTransfer, HTMLElement>;
const cleanup: (() => void | Promise<void>)[] = [];
let clockEpoch = 10_000_000_000_000;
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
  it.each([
    ["pane", "covered"], ["window", "covered"], ["pane", "window-opening"], ["pane", "unavailable"], ["window", "unavailable"], ["pane", "active"], ["window", "active"],
  ] as const)("deferred registered %s dialog drops require %s surface ownership before DOM suspension updates", async (scope, state) => {
    let reject!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const container = scope === "pane" ? dropElement("pane-dialog-container", { "data-pane-id": "owner" }) : null;
    const overlay = dropElement(scope === "pane" ? "modal-overlay pane-scoped" : "modal-overlay", {}, container);
    hit = dropElement("", {}, overlay);
    const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
    let available = true;
    cleanup.push(modalOwnership.registerSurface(() => {}, undefined, undefined, {
      scope: scope === "pane" ? { paneId: "owner", token: Symbol() } : null,
      element: () => overlay, available: () => available,
    }).release);
    hit.dispatchEvent = replay => { Object.defineProperty(replay, "target", { value: hit }); return win.dispatchEvent(replay); };
    const { source, dt } = begin(); win.dispatchEvent(event("drop", dt));
    if (state === "covered") cleanup.push(modalOwnership.registerSurface(() => {}).release);
    if (state === "window-opening") { dialogStore.openSettings(); cleanup.push(() => dialogStore.closeSettings()); }
    if (state === "unavailable") { available = false; modalOwnership.scopeChanged(); }
    source.end(); reject(new Error("native unavailable")); await flush();
    if (state === "active") expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
    else expect(handler).not.toHaveBeenCalled();
    expect(transferFiles).not.toHaveBeenCalled();
  });
  it.each(["window", "destination-pane", "other-pane"] as const)("deferred tab drops re-evaluate %s modality against the tab's owning pane", async modal => {
    let reject!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(windowTabsManager, "tabs", "get").mockReturnValue([
      { id: "destination-tab", kind: "explorer", activePaneId: "destination-pane", panes: { "destination-pane": { path: "/destination" } } },
    ] as any);
    vi.spyOn(windowTabsManager, "activePaneId", "get").mockReturnValue("other-pane");
    vi.spyOn(windowTabsManager, "getTabPath").mockReturnValue("/destination");
    hit = dropElement("tab", { "data-tab-id": "destination-tab" });
    hit.dispatchEvent = replay => { Object.defineProperty(replay, "target", { value: hit }); return win.dispatchEvent(replay); };
    const effects: Promise<void>[] = [];
    win.addEventListener("drop", e => { effects.push(dropIntoDirectory(e as DragEvent, "/destination", "tab", { onRefresh() {} })); });
    const { source, dt } = begin(); win.dispatchEvent(event("drop", dt));
    expect(transferFiles).not.toHaveBeenCalled();
    cleanup.push(modalOwnership.registerSurface(() => {}, undefined, undefined,
      modal === "window" ? {} : { scope: { paneId: modal, token: Symbol() } }).release);
    source.end(); reject(new Error("native unavailable")); await flush(); await Promise.all(effects);
    if (modal === "other-pane") expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination", false, expect.anything());
    else expect(transferFiles).not.toHaveBeenCalled();
  });
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

  it.each(["its row unmounted", "the pane navigated"] as const)("replays a spring-peek drop deferred behind a slow native start by its folder when %s (#1242)", async change => {
    let reject!: (error: Error) => void;
    native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let current = true;
    const explorer = { currentPath: "/destination", springPeeks: ["/destination/Inbox"], isSpringPeek: (path: string) => path === "/destination/Inbox",
      springDropFolder: () => "/destination/Inbox", captureMutation: () => ({ current: () => current }), entryMeta: new Map() };
    vi.spyOn(windowTabsManager, "getExplorer").mockReturnValue(explorer as never);
    hit = dropElement("entry-item", { "data-path": "/destination/Inbox/notes.txt" }, dropElement("explorer-pane", { "data-pane-id": "p" }));
    hit.dispatchEvent = value => { Object.defineProperty(value, "target", { value: hit }); return win.dispatchEvent(value); };
    const { source, dt } = begin(); win.dispatchEvent(event("drop", dt)); source.end();
    // The drag ended: its temporary peek closed and the row it was dropped on unmounted.
    explorer.springPeeks = [];
    Object.defineProperty(hit, "isConnected", { value: false });
    if (change === "the pane navigated") current = false;
    reject(new Error("native unavailable")); await flush();
    const cancelled = toastStore.toasts.some(toast => /drop.*cancel|destination.*chang/i.test(toast.message));
    if (change === "its row unmounted") {
      expect(transferFiles).toHaveBeenCalledExactlyOnceWith(paths, "/destination/Inbox", false, expect.anything());
      expect(cancelled).toBe(false);
    } else {
      expect(transferFiles).not.toHaveBeenCalled();
      expect(cancelled).toBe(true);
    }
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
  it.each([true, false])("carries Miller copy intent through native handoff (Ctrl=%s)", async copying => {
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
    const source = usePointerDrag({ getExplorer: () => ({ getSelectedEntries: () => [entry], currentPath: "/source", refresh: vi.fn(), entryMeta: new Map([[entry.path, { depth: 0 }]]) }) as any });
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

it.each(["application/x-bookmark-index", "text/plain", "application/x-plugin-item"])("%s does not adopt a pending plugin source in sidebar drop/end", async mime => {
  const { dropOnQuickAccess } = await import("$lib/composables/use-sidebar-file-drop");
  const { bookmarksStore } = await import("$lib/state/bookmarks.svelte");
  const pin = vi.spyOn(bookmarksStore, "addBookmark");
  let done!: () => void;
  const wait = new Promise<void>(resolve => { done = resolve; });
  const handler = vi.fn(() => wait); cleanup.push(fileDropTargets.register(hit, handler));
  const old = createHtml5FileDrag(); const oldDt = payload();
  old.start(event("dragstart", oldDt), { path: "/unbookmarked", name: "pending", kind: "directory" }); await flush();
  const owned = dragState.current;
  emit("enter", ["/unbookmarked"]); emit("drop", ["/unbookmarked"]); await flush();
  const dt = payload(); dt.setData(mime, "0");
  cleanup.push(listenSidebarDragEnd({ quickAccess: () => undefined, isDragOver: () => true, reset: vi.fn() }));
  doc.dispatchEvent(event("dragstart", dt));
  dropOnQuickAccess(event("drop", dt));
  doc.dispatchEvent(event("dragend", dt));
  try {
    expect(pin).not.toHaveBeenCalled(); expect(dragState.current?.sessionId).toBe(owned?.sessionId);
  } finally { done(); await flush(); old.end(); }
});

it("a stale DOM session cannot borrow a successor's identical paths for plugin delivery", async () => {
  delete (win as any).__TAURI_INTERNALS__;
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  const old = begin(); old.source.end();
  begin(); const replacement = dragState.current;
  win.dispatchEvent(event("drop", old.dt)); await flush();
  expect(handler).not.toHaveBeenCalled(); expect(dragState.current?.sessionId).toBe(replacement?.sessionId);
});

it("a stale DOM session cannot defer on a successor's rejected native decision", async () => {
  const internals = (win as any).__TAURI_INTERNALS__;
  delete (win as any).__TAURI_INTERNALS__;
  const old = begin(); old.source.end();
  (win as any).__TAURI_INTERNALS__ = internals;
  let reject!: (error: Error) => void;
  native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const successor = begin(); const replacement = dragState.current;
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  win.dispatchEvent(event("drop", old.dt)); await flush();
  reject(new Error("unavailable")); await flush();
  expect(handler).not.toHaveBeenCalled();
  expect(dragState.current?.sessionId).toBe(replacement?.sessionId);
  successor.source.end();
});

it.each(["rejected-before-enter", "enter-before-rejection"])("Linux automatic source:null retains the HTML5 identity (%s)", async ordering => {
  let reject!: (error: Error) => void;
  native.start.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  const { source, dt } = begin(true);
  const automatic = (type: string, incoming = [...paths].reverse()) => native.emit!({ payload: {
    type, paths: incoming, source: null, position: { x: 40, y: 60 }, copyModifier: true,
  } });
  if (ordering === "rejected-before-enter") { reject(new Error("unavailable")); await flush(); }
  automatic("enter");
  if (ordering === "enter-before-rejection") {
    doc.dispatchEvent(event("dragend", dt)); source.end(); reject(new Error("unavailable")); await flush();
  }
  automatic("drop"); await flush();
  win.dispatchEvent(event("drop", dt, true)); await flush();
  expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
  source.end();
  // Neither a later external gesture nor a mismatching complete path set may
  // reuse the retired Explorer identity, even when the paths overlap.
  automatic("enter"); automatic("drop"); await flush();
  expect(handler).toHaveBeenLastCalledWith([...paths].reverse(), "external");
  expect(handler).toHaveBeenCalledTimes(2);
});

it("source:null cannot adopt an acknowledged native source solely by matching paths", async () => {
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  begin(); await flush();
  const source = dragState.current;
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths, position: { x: 40, y: 60 }, source: null } });
  await flush();
  expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "external");
  expect(dragState.current?.sessionId).toBe(source?.sessionId);
});

it.each(["modal", "plugin"])("ordinary text DOM payloads pass through %s while native start is pending", async surface => {
  native.start.mockImplementationOnce(() => new Promise<void>(() => {}));
  begin();
  hit = dropElement(surface === "modal" ? "modal-overlay" : "plugin-file-view");
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  const listener = vi.fn(); win.addEventListener("drop", listener);
  const dt = payload(); dt.setData("text/plain", "description");
  const over = event("dragover", dt), drop = event("drop", dt);
  win.dispatchEvent(over); win.dispatchEvent(drop); await flush();
  expect(over.defaultPrevented).toBe(false); expect(drop.defaultPrevented).toBe(false);
  expect(listener).toHaveBeenCalledExactlyOnceWith(drop);
  expect(handler).not.toHaveBeenCalled();
});

it("Linux receiver observation preserves a rejected HTML5 gesture when queued Enter arrives after dragend", async () => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  native.start.mockRejectedValueOnce(new Error("unavailable"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  const original = begin(); await flush();
  tick = 12; original.source.end();
  expect(dragState.current).toBeNull();
  const observed = (type: string, observedAt: number) => native.emit!({ payload: { type, paths, position: { x: 40, y: 60 }, source: null, observedAt } });
  observed("enter", epoch + 11); observed("drop", epoch + 11.5); await flush();
  expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
  observed("enter", epoch + 13); observed("drop", epoch + 13.5); await flush();
  expect(handler).toHaveBeenLastCalledWith(paths, "external");
  expect(handler).toHaveBeenCalledTimes(2);
});

it("queued automatic native delivery cannot repeat an already delivered DOM fallback", async () => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  native.start.mockRejectedValueOnce(new Error("unavailable"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  const { source, dt } = begin(); await flush();
  win.dispatchEvent(event("drop", dt)); await flush();
  tick = 12; source.end();
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths, position: { x: 40, y: 60 }, source: null, observedAt: epoch + 11 } });
  await flush();
  expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
});

it("evicted HTML5 observations fail closed instead of becoming external file operations", async () => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  native.start.mockRejectedValue(new Error("unavailable"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const original = begin(); await flush(); tick = 12; original.source.end();
  for (let i = 0; i < 8; i++) { tick = 20 + i * 2; const next = begin(); await flush(); tick++; next.source.end(); }
  hit = dropElement("bookmark-drop-target", { "data-path": "/destination" });
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths, position: { x: 40, y: 60 }, source: null, observedAt: epoch + 11 } });
  await flush();
  expect(transferFiles).not.toHaveBeenCalled();
  expect(toastStore.toasts.some(toast => /drop.*cancel|gesture.*expir/i.test(toast.message))).toBe(true);
  const stale = event("drop", original.dt); const listener = vi.fn(); win.addEventListener("drop", listener);
  win.dispatchEvent(stale); await flush(); expect(listener).not.toHaveBeenCalled();
});

it("history persistence failure cannot erase a live or ended local HTML5 source", async () => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
    if (key === "explorer-html5-gestures") throw new Error("QuotaExceeded");
    setItem(key, value);
  });
  native.start.mockRejectedValue(new Error("unavailable")); vi.spyOn(console, "warn").mockImplementation(() => {});
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  const { source } = begin(); await flush(); tick = 12; source.end();
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths, position: { x: 40, y: 60 }, source: null, observedAt: epoch + 11 } });
  await flush(); expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
});

it("authoritative Rust source identity wins over an ambiguous HTML5 end millisecond", async () => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  const { source } = begin(); await flush(); const captured = { ...dragState.current };
  tick = 12; source.end();
  for (const [type, observedAt] of [["enter", epoch + 12.2], ["drop", epoch + 15]] as const) native.emit!({ payload: { type, paths, position: { x: 40, y: 60 }, source: captured, observedAt } });
  await flush(); expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
});

it("a backwards clock interval cannot poison later unrelated native drops", async () => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  native.start.mockRejectedValue(new Error("unavailable")); vi.spyOn(console, "warn").mockImplementation(() => {});
  const old = begin(); await flush(); tick = 5; old.source.end();
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths: ["/external/fresh.png"], position: { x: 40, y: 60 }, source: null, observedAt: epoch + 100 } });
  await flush(); expect(handler).toHaveBeenCalledExactlyOnceWith(["/external/fresh.png"], "external");
});

it("stale persisted history cannot evict a newer local gesture after quota failure", async () => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  native.start.mockRejectedValue(new Error("unavailable")); vi.spyOn(console, "warn").mockImplementation(() => {});
  for (let i = 0; i < 8; i++) { tick = 10 + 2 * i; const old = begin(); await flush(); tick++; old.source.end(); }
  const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => { if (key !== "explorer-html5-gestures") setItem(key, value); });
  tick = 30; const live = begin(); await flush();
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  for (let i = 0; i < 4; i++) {
    native.emit!({ payload: { type: "enter", paths, position: { x: 40, y: 60 }, source: null, observedAt: epoch + 31 } });
    native.emit!({ payload: { type: "leave" } });
  }
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths, position: { x: 40, y: 60 }, source: null, observedAt: epoch + 31 } });
  await flush(); expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane"); live.source.end();
});

it.each(["live", "ended"])("a receiver without persisted history never treats a rejected HTML5 source as external (%s)", async phase => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  const write = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => { if (key !== "explorer-html5-gestures") write(key, value); });
  native.start.mockRejectedValue(new Error("unavailable")); vi.spyOn(console, "warn").mockImplementation(() => {});
  const original = begin(); await flush(); cleanup[0]();
  if (phase === "ended") { tick = 12; original.source.end(); }
  vi.resetModules();
  const receiver = await import("$lib/composables/use-native-drop-handler");
  const targets = await import("$lib/state/file-drop-targets.svelte");
  const receiverToasts = await import("$lib/state/toast.svelte");
  const handler = vi.fn(); cleanup.push(targets.fileDropTargets.register(hit, handler));
  const service = receiver.useNativeDropHandler({ getActiveExplorer: () => undefined, refreshAllPanes: vi.fn() });
  service.setup(); cleanup.push(service.cleanup); await flush();
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths, position: { x: 40, y: 60 }, source: null, observedAt: epoch + 11 } });
  await flush();
  if (phase === "live") expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
  else { expect(handler).not.toHaveBeenCalled(); expect(receiverToasts.toastStore.toasts.some(toast => /drop.*cancel/i.test(toast.message))).toBe(true); }
  original.source.end();
});

it.each(["receiver", "local"])("replacing a rejected decision preserves the predecessor's authority after history write failure (%s)", async route => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  const write = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => { if (key !== "explorer-html5-gestures") write(key, value); });
  native.start.mockRejectedValue(new Error("unavailable")); vi.spyOn(console, "warn").mockImplementation(() => {});
  const first = begin(); await flush(); tick = 12; first.source.end();
  tick = 20; const successor = begin(); await flush(); tick = 22; successor.source.end();
  let targets = fileDropTargets, toasts = toastStore;
  if (route === "receiver") {
    cleanup[0](); vi.resetModules();
    const receiver = await import("$lib/composables/use-native-drop-handler");
    targets = (await import("$lib/state/file-drop-targets.svelte")).fileDropTargets;
    toasts = (await import("$lib/state/toast.svelte")).toastStore;
    const service = receiver.useNativeDropHandler({ getActiveExplorer: () => undefined, refreshAllPanes: vi.fn() });
    service.setup(); cleanup.push(service.cleanup); await flush();
  }
  const handler = vi.fn(); cleanup.push(targets.register(hit, handler));
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths, position: { x: 40, y: 60 }, source: null, observedAt: epoch + 11 } });
  await flush();
  if (route === "local") expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
  else { expect(handler).not.toHaveBeenCalled(); expect(toasts.toasts.some(toast => /drop.*cancel/i.test(toast.message))).toBe(true); }
  handler.mockClear();
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths: ["/external/fresh.png"], position: { x: 40, y: 60 }, source: null, observedAt: epoch + 30 } });
  await flush(); expect(handler).toHaveBeenCalledExactlyOnceWith(["/external/fresh.png"], "external");
});


it("a blocked completion clears its existing destination highlight without waiting for dragend", async () => {
  dragState.start({ ...entry, nativeCopyPolicy: "modifier" });
  highlightTargetAtPoint(20, 30);
  expect(hit.classList.contains("drop-target")).toBe(true);
  const release = modalOwnership.registerSurface(() => {}).release;
  try {
    emit("enter", [entry.path]); emit("drop", [entry.path]); await flush();
    expect(hit.classList.contains("drop-target")).toBe(false);
    expect(transferFiles).not.toHaveBeenCalled();
  } finally { release(); }
});

it("sidebar capture cannot replay a completed source after the completion receipt expires", async () => {
  const { bookmarksStore } = await import("$lib/state/bookmarks.svelte");
  const pin = vi.spyOn(bookmarksStore, "addBookmark").mockImplementation(() => false);
  hit = dropElement("quick-access");
  cleanup.push(listenSidebarDragEnd({ quickAccess: () => hit, isDragOver: () => true, reset() {} }));
  delete (win as any).__TAURI_INTERNALS__;
  const source = createHtml5FileDrag(); const dt = payload();
  source.start(event("dragstart", dt), { path: "/source/directory", name: "directory", kind: "directory" });
  doc.dispatchEvent(event("dragstart", dt));
  const completed = dragState.claim(dragState.current)!; completed.finish();
  for (let i = 0; i < 8; i++) {
    dragState.start({ path: `/successor/${i}`, name: "successor", kind: "directory" });
    dragState.finish(dragState.current);
  }
  doc.dispatchEvent(event("dragend", payload(), false, sourceElements.get(dt))); source.end();
  expect(pin).not.toHaveBeenCalled();
});

it.each(["absent", "disconnected", "reowned"] as const)("sidebar capture does not pin from stale hover when Quick Access is %s", async state => {
  const { bookmarksStore } = await import("$lib/state/bookmarks.svelte");
  const pin = vi.spyOn(bookmarksStore, "addBookmark").mockImplementation(() => false);
  const access = dropElement("quick-access");
  cleanup.push(listenSidebarDragEnd({ quickAccess: () => state === "absent" ? undefined : access, isDragOver: () => true, reset() {} }));
  delete (win as any).__TAURI_INTERNALS__;
  const source = createHtml5FileDrag(); const dt = payload();
  source.start(event("dragstart", dt), { path: "/source/directory", name: "directory", kind: "directory" });
  doc.dispatchEvent(event("dragstart", dt));
  if (state === "reowned") cleanup.push(fileDropTargets.register(access, vi.fn()));
  else if (state === "disconnected") Object.defineProperty(access, "isConnected", { value: false });
  doc.dispatchEvent(event("dragend", payload(), false, sourceElements.get(dt))); source.end();
  expect(pin).not.toHaveBeenCalled();
});

// External observations stay in the platform's monotonic domain while the
// adjustable wall clock can jump. Include the first eviction and a new realm.
it.each(dropClockCases)("fresh external plugin drops survive $direction correction after $priorGestures gestures (restart=$restart)", async ({ direction, priorGestures, restart }) => {
  let tick = 10;
  const epoch = clockEpoch += 1000;
  let wall = epoch + 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => wall + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  native.start.mockRejectedValue(new Error("unavailable"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (let i = 0; i < priorGestures; i++) { tick = 10 + 2 * i; const old = begin(); await flush(); tick++; old.source.end(); }
  wall += direction === "backward" ? -2_000_000 : 2_000_000;
  tick = 40;
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  const externalPaths = ["/external/fresh.png"];
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths: externalPaths, position: { x: 40, y: 60 }, source: null, observedAt: epoch + tick } });
  await flush();
  expect(handler).toHaveBeenCalledExactlyOnceWith(externalPaths, "external");
  if (!restart) return;
  cleanup[0](); vi.resetModules();
  // A renderer/application restart gets a new clock origin. Persisted old
  // timestamps have no authority in that domain, whichever way wall time moved.
  const restartEpoch = wall;
  vi.stubGlobal("performance", { timeOrigin: restartEpoch, now: () => tick });
  const receiver = await import("$lib/composables/use-native-drop-handler");
  const targets = await import("$lib/state/file-drop-targets.svelte");
  const restartedHandler = vi.fn(); cleanup.push(targets.fileDropTargets.register(hit, restartedHandler));
  const service = receiver.useNativeDropHandler({ getActiveExplorer: () => undefined, refreshAllPanes: vi.fn() });
  service.setup(); cleanup.push(service.cleanup); await flush();
  for (const type of ["enter", "drop"]) native.emit!({ payload: { type, paths: externalPaths, position: { x: 40, y: 60 }, source: null, observedAt: restartEpoch + tick } });
  await flush();
  expect(restartedHandler).toHaveBeenCalledExactlyOnceWith(externalPaths, "external");
});

it.each(["verified", "different-paths", "stale-sequence"] as const)("final %s native provenance rechecks an ambiguous early Enter (#1217)", async (kind) => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  tick = 9;
  dragState.start({ ...entry, paths: [...paths], html5: true });
  tick = 10;
  dragState.endHtml5(dragState.current);
  begin(); await flush();
  const original = { ...dragState.current! };
  // WebKit Enter can beat adoption inside the previous gesture's end uncertainty.
  native.emit!({ payload: { type: "enter", paths, source: null, observedAt: epoch + 10.25, position: { x: 40, y: 60 } } });
  tick = 12;
  const source = kind === "different-paths" ? { ...original, path: "/other", paths: ["/other"] }
    : kind === "stale-sequence" ? { ...original, gestureSequence: 0 } : original;
  native.emit!({ payload: { type: "drop", paths, source, observedAt: epoch + 11, position: { x: 40, y: 60 } } });
  await flush();
  if (kind === "verified") expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
  else expect(handler).not.toHaveBeenCalled();
});

it.each(["fresh-enter", "old-enter"] as const)("proven external GTK source keeps external policy with %s and an unsettled own source (#1217)", async kind => {
  let tick = 10; const epoch = clockEpoch += 1000;
  vi.spyOn(Date, "now").mockImplementation(() => epoch + tick);
  vi.stubGlobal("performance", { timeOrigin: epoch, now: () => tick });
  native.start.mockImplementationOnce(() => new Promise<void>(() => {}));
  const handler = vi.fn(); cleanup.push(fileDropTargets.register(hit, handler));
  begin(); await flush();
  const source = dragState.current!;
  const deliver = (type: string, externalSource?: boolean) => native.emit!({ payload: {
    type, paths, source: null, externalSource, observedAt: epoch + tick,
    observationClock: `browser:${epoch}`, position: { x: 40, y: 60 },
  } });
  if (kind === "old-enter") deliver("enter");
  tick = 20;
  if (kind === "fresh-enter") deliver("enter", true);
  deliver("drop", true); await flush();
  expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "external");
  expect(dragState.current?.sessionId).toBe(source.sessionId);
});
