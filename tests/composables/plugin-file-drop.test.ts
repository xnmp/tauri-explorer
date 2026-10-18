import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ deliver: null as ((event: any) => void) | null }));
const transfer = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({
  listen: async (_name: string, listener: (event: any) => void) => { native.deliver = listener; return vi.fn(); },
}) }));
vi.mock("$lib/state/drop-operations", () => ({ handleFileDropMany: transfer }));
vi.mock("$lib/composables/use-external-drag.svelte", () => ({ startExternalDrag: vi.fn() }));

import { useNativeDropHandler } from "$lib/composables/use-native-drop-handler";
import { useSidebarDrag } from "$lib/composables/use-sidebar-drag.svelte";
import { usePointerDrag } from "$lib/composables/use-pointer-drag.svelte";
import { dropHover } from "$lib/state/drop-hover";
import { dragState } from "$lib/state/drag.svelte";
import { fileDropTargets } from "$lib/state/file-drop-targets.svelte";
import { highlightTargetAtPoint, clearHighlights } from "$lib/composables/use-native-drop-target.svelte";
import { dropElement } from "../helpers/drop-element";

let listeners: Record<string, Set<(event: any) => unknown>>;
let hit: HTMLElement;
const disposers: (() => void)[] = [];
const entry = (path: string) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file", size: 1, modified: "" }) as const;
const paths = ["/source/z.png", "/source/a.png"];
function start() { dragState.start({ ...entry(paths[1]), paths: [...paths] }); }
async function nativeDrop(paths: string[], position: { x: number; y: number }) {
  nativeEvent("drop", paths, position);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
function nativeEvent(type: string, paths: string[] = [], position = { x: 40, y: 60 }) {
  native.deliver!({ payload: { type, paths, position } });
}
function fire(type: string, event: any) { return Promise.all([...listeners[type] ?? []].map(listener => listener(event))); }
function dom(data: Record<string, string>, extra: Record<string, unknown> = {}) {
  return { target: hit, clientX: 20, clientY: 30, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), dataTransfer: { types: Object.keys(data), getData: (type: string) => data[type] ?? "", ...extra } };
}
function register(handler = vi.fn(), enabled?: () => boolean) { disposers.push(fileDropTargets.register(hit, handler, { enabled })); return handler; }
async function setup(active = true) {
  native.deliver = null;
  const service = useNativeDropHandler({ getActiveExplorer: () => active ? ({ currentPath: "/destination" } as any) : undefined, refreshAllPanes: vi.fn() });
  service.setup(); disposers.push(service.cleanup);
  await vi.waitFor(() => expect(native.deliver).not.toBeNull());
}
beforeEach(() => {
  dragState.clear(); transfer.mockClear(); listeners = {}; hit = dropElement();
  vi.stubGlobal("window", { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2,
    addEventListener: (type: string, listener: (event: any) => unknown) => (listeners[type] ??= new Set()).add(listener),
    removeEventListener: (type: string, listener: (event: any) => unknown) => listeners[type]?.delete(listener) });
  vi.stubGlobal("document", { elementFromPoint: vi.fn(() => hit), documentElement: { style: { zoom: "150%" } },
    createElement: () => ({ style: {}, remove: vi.fn() }), body: { style: {}, appendChild: vi.fn() } });
});
afterEach(() => { disposers.splice(0).reverse().forEach(dispose => dispose()); dragState.clear(); clearHighlights(); vi.unstubAllGlobals(); });

describe("plugin native file drops", () => {
  it("retires native hover on matching DOM dragend without resurrecting it on layout", async () => {
    register(); await setup(); start();
    const source = dragState.current!;
    nativeEvent("enter", paths);
    expect(hit.classList.contains("drop-target")).toBe(true);
    await fire("dragend", dom({ "application/x-explorer-path": source.path, "application/x-explorer-session": source.sessionId! }));
    expect(hit.classList.contains("drop-target")).toBe(false);
    dropHover.refresh();
    expect(hit.classList.contains("drop-target")).toBe(false);
  });

  it("keeps successor hover when an older DOM dragend arrives", async () => {
    register(); await setup(); start();
    const first = dragState.current!;
    nativeEvent("enter", paths);
    start(); nativeEvent("enter", paths);
    await fire("dragend", dom({ "application/x-explorer-path": first.path, "application/x-explorer-session": first.sessionId! }));
    expect(hit.classList.contains("drop-target")).toBe(true);
    dropHover.refresh();
    expect(hit.classList.contains("drop-target")).toBe(true);
  });

  it("snapshots the ordered paths before awaiting a consumer", async () => {
    let finish!: () => void; const received: string[][] = [];
    const handler = register(vi.fn(async (batch: readonly string[]) => {
      await new Promise<void>(resolve => { finish = resolve; }); received.push([...batch]);
    }));
    await setup(); start(); const incoming = [...paths]; const pending = nativeDrop(incoming, { x: 40, y: 60 });
    incoming.reverse(); incoming.push("/later.png");
    finish(); await pending;
    expect(received).toEqual([paths]); expect(handler).toHaveBeenCalledTimes(1); expect(transfer).not.toHaveBeenCalled();
  });

  it("delivers the complete live selection in Explorer order with no active explorer or transfer", async () => {
    const handler = register(); await setup(false); start();
    await nativeDrop([...paths].reverse(), { x: 300, y: 450 });
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
    expect(transfer).not.toHaveBeenCalled(); expect(dragState.current).toBeNull();
    expect(document.elementFromPoint).toHaveBeenCalledWith(150, 225);
  });

  it.each([[paths[0]], [paths[0], "/unrelated.png"], [paths[0], paths[0]]].map(incoming => [incoming]))("does not substitute an incomplete or mismatched native set: %j", async incoming => {
    const handler = register(); await setup(); start();
    const original = dragState.current;
    await nativeDrop(incoming, { x: 1, y: 2 });
    expect(handler).toHaveBeenCalledExactlyOnceWith(incoming, "external");
    expect(dragState.current).toBe(original); expect(transfer).not.toHaveBeenCalled();
  });

  it("retains verified source order when native source completion arrives before destination Drop", async () => {
    const handler = register(); await setup(); start(); const source = dragState.current;
    nativeEvent("enter", paths, { x: 40, y: 60 });
    dragState.finish(source);
    await nativeDrop([...paths].reverse(), { x: 40, y: 60 });
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane"); expect(transfer).not.toHaveBeenCalled();
  });

  it("drops the receiver snapshot on Leave and new Enter", async () => {
    const handler = register(); await setup(); start();
    nativeEvent("enter", paths, { x: 40, y: 60 }); dragState.clear(); nativeEvent("leave");
    nativeEvent("enter", paths, { x: 40, y: 60 });
    await nativeDrop(paths, { x: 40, y: 60 });
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "external");
  });

  it("revalidates the entire set at Drop after a verified Enter", async () => {
    const handler = register(); await setup(); start(); nativeEvent("enter", paths, { x: 40, y: 60 });
    await nativeDrop([paths[0]], { x: 40, y: 60 });
    expect(handler).toHaveBeenCalledExactlyOnceWith([paths[0]], "external"); expect(transfer).not.toHaveBeenCalled();
  });

  it("delivers authoritative external paths without guessing from live state", async () => {
    const handler = register(); await setup();
    await nativeDrop(["file:///external/b.png\r\nfile:///external/a.png"], { x: 1, y: 2 });
    expect(handler).toHaveBeenCalledExactlyOnceWith(["/external/b.png", "/external/a.png"], "external");
    expect(transfer).not.toHaveBeenCalled();
  });

  it.each(["disabled", "modal", "inert"])("consumes %s drops without delivery or transfer", async mode => {
    const handler = register(vi.fn(), () => mode !== "disabled");
    if (mode === "modal") hit = dropElement("modal-overlay");
    if (mode === "inert") hit = dropElement("", { inert: "" }, hit);
    await setup(); start(); await nativeDrop(paths, { x: 1, y: 2 });
    expect(handler).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled(); expect(dragState.current).toBeNull();
  });

  it("does not let a late native Leave clear a successor pointer highlight", async () => {
    let finish!: () => void; register(vi.fn(() => new Promise<void>(resolve => { finish = resolve; })));
    await setup(); start(); nativeEvent("enter", paths, { x: 40, y: 60 }); nativeEvent("over", [], { x: 40, y: 60 });
    const pending = nativeDrop(paths, { x: 40, y: 60 });
    hit = dropElement("entry-item directory", { "data-path": "/new-target" });
    dragState.start(entry("/new-drag.png")); highlightTargetAtPoint(20, 30);
    nativeEvent("leave"); expect(hit.classList.contains("drop-target")).toBe(true);
    finish(); await pending; expect(hit.classList.contains("drop-target")).toBe(true);
  });

  it("claims before awaiting and preserves replacement drag state and feedback on completion", async () => {
    let finish!: () => void;
    const handler = register(vi.fn(() => new Promise<void>(resolve => { finish = resolve; })));
    await setup(); start(); highlightTargetAtPoint(20, 30);
    const pending = nativeDrop(paths, { x: 40, y: 60 });
    await nativeDrop(paths, { x: 40, y: 60 });
    expect(handler).toHaveBeenCalledTimes(1);
    hit = dropElement("entry-item directory", { "data-path": "/new-target" });
    dragState.start(entry("/new-drag.png")); const replacement = dragState.current;
    highlightTargetAtPoint(20, 30); finish(); await pending;
    expect(dragState.current).toBe(replacement);
    expect(hit.classList.contains("drop-target")).toBe(true);
    expect(dragState.readCrossWindow()?.path).toBe("/new-drag.png");
    expect(transfer).not.toHaveBeenCalled();
  });
});

describe("plugin DOM file drops", () => {
  it("delivers verified internal MIME once, ordered by the live Explorer drag", async () => {
    const handler = register(); await setup(); start();
    const event = dom({ "application/x-explorer-path": paths[1], "application/x-explorer-paths": JSON.stringify([...paths].reverse()) });
    await fire("drop", event);
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane"); expect(transfer).not.toHaveBeenCalled();
  });

  it.each(['null', '[]', '["/source/z.png", 1]', '["/source/z.png", "relative.png"]', '["/source/z.png", "/forged.png"]'])("consumes malformed or unrelated MIME without fallback: %s", async payload => {
    const handler = register(); await setup(); start();
    const event = dom({ "application/x-explorer-path": paths[1], "application/x-explorer-paths": payload });
    await fire("drop", event); expect(handler).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
  });

  it("rejects forged Explorer MIME without a live drag", async () => {
    const handler = register(); await setup();
    await fire("drop", dom({ "application/x-explorer-path": "/source/a.png" }));
    expect(handler).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
  });

  it("ignores external DOM files, File.name, guessed File.path and URI text", async () => {
    const handler = register(); await setup(); start();
    const original = dragState.current;
    await fire("drop", dom({ Files: "", "text/uri-list": "file:///external.png", "text/plain": "/external.png" }, { files: [{ name: "external.png", path: "/external.png" }] }));
    expect(handler).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled();
    expect(dragState.current).toBe(original);
  });

  it("gives a successful native handoff sole authority over matching DOM MIME", async () => {
    const handler = register(); await setup(); start(); Object.assign(window, { __TAURI_INTERNALS__: {} });
    nativeEvent("enter", paths);
    const event = dom({ "application/x-explorer-paths": JSON.stringify(paths) });
    await fire("drop", event); expect(handler).not.toHaveBeenCalled(); expect(dragState.current).not.toBeNull();
    await nativeDrop(paths, { x: 40, y: 60 });
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
    await fire("drop", event); expect(handler).toHaveBeenCalledTimes(1); expect(transfer).not.toHaveBeenCalled();
  });
});

describe("plugin pointer drops", () => {
  it("releases sidebar listeners before a synchronous consumer starts another gesture", async () => {
    const drag = useSidebarDrag();
    const down = { button: 0, clientX: 10, clientY: 10, preventDefault: vi.fn(), currentTarget: { querySelector: () => null } } as any;
    register(vi.fn(() => drag.handlePointerDown(down, "/successor", "successor")));
    drag.handlePointerDown(down, "/original", "original"); await fire("mousemove", { clientX: 20, clientY: 30 });
    await fire("mouseup", { clientX: 300, clientY: 450 }); expect(listeners.mouseup.size).toBe(1);
    await fire("mousemove", { clientX: 20, clientY: 30 }); expect(dragState.current?.path).toBe("/successor");
    await fire("keydown", { key: "Escape" });
  });

  it("routes Recent sidebar pointer sources through the same claimed target", async () => {
    const handler = register(); const drag = useSidebarDrag();
    drag.handlePointerDown({ button: 0, clientX: 10, clientY: 10, preventDefault: vi.fn(), currentTarget: { querySelector: () => null } } as any, "/recent/folder", "folder");
    await fire("mousemove", { clientX: 20, clientY: 30 });
    await fire("mouseup", { clientX: 300, clientY: 450 });
    expect(handler).toHaveBeenCalledExactlyOnceWith(["/recent/folder"], "pane"); expect(transfer).not.toHaveBeenCalled();
    expect(dragState.current).toBeNull(); expect(listeners.mouseup.size).toBe(0);
  });

  it("delivers two selected files in order without transferring, using raw client coordinates", async () => {
    const handler = register();
    const explorer = { currentPath: "/source", getSelectedEntries: () => paths.map(entry), refresh: vi.fn(), entryMeta: new Map(paths.map(path => [path, { depth: 0 }])) } as any;
    const drag = usePointerDrag({ getExplorer: () => explorer });
    drag.handlePointerDown({ button: 0, clientX: 10, clientY: 10, preventDefault: vi.fn(), currentTarget: { querySelector: () => null } } as any, entry(paths[1]), true);
    await fire("mousemove", { clientX: 20, clientY: 30 });
    await fire("mouseup", { clientX: 300, clientY: 450, altKey: false });
    expect(handler).toHaveBeenCalledExactlyOnceWith(paths, "pane");
    expect(document.elementFromPoint).toHaveBeenLastCalledWith(300, 450);
    expect(transfer).not.toHaveBeenCalled(); expect(dragState.current).toBeNull();
    expect(listeners.mouseup.size).toBe(0);
  });
});
