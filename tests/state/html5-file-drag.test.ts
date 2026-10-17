import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("$lib/state/drag-clock", async actual => ({ ...await actual<object>(), dragClock: {
  initialize: async () => {}, ready: true,
  stamp: () => ({ clockId: `browser:${performance.timeOrigin}`, at: Math.floor(performance.timeOrigin + performance.now()), uncertainty: 0 }),
} }));
const owners = vi.hoisted(() => ({ destroy: [] as (() => void)[] }));
vi.mock("svelte", async actual => ({ ...await actual<object>(), onDestroy: (cleanup: () => void) => owners.destroy.push(cleanup) }));
const native = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const nativeEnd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("$lib/api/native-file-drag", () => ({ startFileDrag: native, endHtml5FileDrag: nativeEnd }));
import { createHtml5FileDrag } from "$lib/state/html5-file-drag.svelte";
import { dragState } from "$lib/state/drag.svelte";
import { listenSidebarDragEnd } from "$lib/composables/use-sidebar-drag-end";

function transfer() {
  const values = new Map<string, string>();
  return { setData: (type: string, value: string) => values.set(type, value), getData: (type: string) => values.get(type) ?? "", effectAllowed: "none" } as unknown as DataTransfer;
}
const data = { path: "/z.png", name: "z.png", kind: "file", paths: ["/z.png", "/a.png"] };
beforeEach(() => { dragState.clear(); native.mockClear(); nativeEnd.mockClear(); owners.destroy = []; });
afterEach(() => { for (const call of native.mock.calls) call[1]?.({ result: "Cancelled" }); dragState.clear(); vi.unstubAllGlobals(); });

describe("shared HTML5 filesystem source protocol", () => {
  it("Recent retains internal link authority without exporting filesystem URIs or starting native drag", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const payload = transfer();
    const source = createHtml5FileDrag(() => {}, "link");
    source.start({ dataTransfer: payload } as DragEvent, { path: "/work/project", name: "project", kind: "directory" });
    expect(payload.effectAllowed).toBe("link");
    expect(payload.getData("text/uri-list")).toBe(`urn:tauri-explorer:drag:${dragState.current?.sessionId}`);
    expect(payload.getData("text/plain")).toBe("");
    expect(native).not.toHaveBeenCalled();
    source.end();
  });
  it("publishes ordered MIME, absolute URI paths and a live gesture for browser drops", () => {
    vi.stubGlobal("window", {}); const payload = transfer(); const onEnd = vi.fn(); const source = createHtml5FileDrag(onEnd);
    source.start({ dataTransfer: payload } as DragEvent, data);
    expect(payload.effectAllowed).toBe("all");
    expect(payload.getData("application/x-explorer-paths")).toBe(JSON.stringify(data.paths));
    expect(payload.getData("text/uri-list")).toBe("file:///z.png\r\nfile:///a.png");
    expect(dragState.current?.paths).toEqual(data.paths); expect(native).not.toHaveBeenCalled();
    source.end(); expect(dragState.current).toBeNull(); expect(onEnd).toHaveBeenCalledOnce();
  });

  it("hands Linux app sources to native and preserves them through an early DOM dragend", () => {
    vi.stubGlobal("window", Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} })); const source = createHtml5FileDrag();
    const document = new EventTarget(); vi.stubGlobal("document", document);
    const stop = listenSidebarDragEnd({ quickAccess: () => undefined, isDragOver: () => false, reset: vi.fn() });
    source.start({ dataTransfer: transfer() } as DragEvent, data); const original = dragState.current;
    expect(native.mock.calls[0][0].item).toEqual(data.paths);
    document.dispatchEvent(new Event("dragstart"));
    document.dispatchEvent(new Event("dragend")); stop();
    source.end();
    expect(dragState.current?.sessionId).toBe(original?.sessionId);
    expect(dragState.readCrossWindow()?.paths).toEqual(data.paths);
    expect(dragState.survivingHtml5Source()).toBeNull();
  });

  it("publishes the native protocol for Miller single directory sources", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} }); const payload = transfer();
    const source = createHtml5FileDrag(); source.start({ dataTransfer: payload } as DragEvent, { path: "/my folder", name: "my folder", kind: "directory" });
    expect(payload.getData("application/x-explorer-path")).toBe("/my folder");
    expect(payload.getData("application/x-explorer-kind")).toBe("directory");
    expect(payload.getData("text/uri-list")).toBe("file:///my%20folder");
    expect(native.mock.calls[0][0].item).toEqual(["/my folder"]);
  });

  it("keeps a newer gesture intact when an old browser source ends", () => {
    vi.stubGlobal("window", {}); const source = createHtml5FileDrag();
    source.start({ dataTransfer: transfer() } as DragEvent, data);
    dragState.start({ path: "/new.png", name: "new.png", kind: "file" }); const current = dragState.current;
    source.end(); expect(dragState.current).toBe(current); expect(dragState.readCrossWindow()?.path).toBe("/new.png");
  });
});

it("retires an unmounted HTML5 owner without lending its policy to later external drops (#1217)", async () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }));
  native.mockRejectedValueOnce(new Error("WebKit owns this HTML5 file drag"));
  const source = createHtml5FileDrag(() => {}, "move");
  source.start({ dataTransfer: transfer() } as DragEvent, data);
  await vi.waitFor(() => expect(dragState.current?.transport).toBeUndefined());
  const original = dragState.current!;
  // Framework destruction can replace a virtualized row before dragend.
  owners.destroy.forEach(destroy => destroy());
  expect(nativeEnd).toHaveBeenCalledExactlyOnceWith(original, "owner-disposed");
  expect(dragState.current).toBeNull();
  expect(dragState.hasLiveHtml5Gesture()).toBe(false);
  const { dragClock } = await import("$lib/state/drag-clock");
  const clock = dragClock.stamp();
  expect(dragState.survivingHtml5Source(clock.at + 60_000, 0, clock.clockId)).toBeNull();
  expect(dragState.latestSource()?.sessionId).not.toBe(original.sessionId);
});

it("keeps the successor when a destroyed owner's pending handoff rejects (#1217)", async () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }));
  let reject!: (reason: Error) => void;
  native.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const refresh = vi.fn();
  const first = createHtml5FileDrag(refresh, "move");
  first.start({ dataTransfer: transfer() } as DragEvent, data);
  owners.destroy[0]();
  const next = createHtml5FileDrag(() => {}, "move");
  next.start({ dataTransfer: transfer() } as DragEvent, { path: "/next.txt", name: "next.txt", kind: "file" });
  const successor = dragState.current!;
  reject(new Error("handoff rejected after owner destruction"));
  await vi.waitFor(() => expect(dragState.current?.transport).toBe("native"));
  expect(dragState.current?.sessionId).toBe(successor.sessionId);
  expect(dragState.readCrossWindow()?.path).toBe("/next.txt");
  expect(refresh).not.toHaveBeenCalled();
});

it("retires a virtualized row while its shared view owner remains mounted (#1217)", () => {
  vi.stubGlobal("window", {});
  const source = createHtml5FileDrag();
  const first = {} as HTMLElement;
  const other = {} as HTMLElement;
  const row = source.trackSource(first);
  const unrelated = source.trackSource(other);
  source.start({ dataTransfer: transfer(), currentTarget: first } as unknown as DragEvent, data);
  unrelated.destroy();
  expect(dragState.hasLiveHtml5Gesture()).toBe(true);
  row.destroy();
  expect(dragState.hasLiveHtml5Gesture()).toBe(false);
  expect(dragState.current).toBeNull();
});

it("ignores a removed row's late dragend after another row starts dragging (#1217)", () => {
  vi.stubGlobal("window", {});
  const source = createHtml5FileDrag();
  const first = {} as HTMLElement;
  const next = {} as HTMLElement;
  const old = source.trackSource(first);
  source.start({ dataTransfer: transfer(), currentTarget: first } as unknown as DragEvent, data);
  source.start({ dataTransfer: transfer(), currentTarget: next } as unknown as DragEvent, { path: "/next", name: "next", kind: "file" });
  const successor = dragState.current!;
  old.destroy();
  source.end({ currentTarget: first } as unknown as DragEvent);
  expect(dragState.current?.sessionId).toBe(successor.sessionId);
  expect(dragState.hasLiveHtml5Gesture()).toBe(true);
});
