import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("$lib/api/native-file-drag", () => ({ startFileDrag: native }));
import { createHtml5FileDrag } from "$lib/state/html5-file-drag.svelte";
import { dragState } from "$lib/state/drag.svelte";
import { listenSidebarDragEnd } from "$lib/composables/use-sidebar-drag-end";

function transfer() {
  const values = new Map<string, string>();
  return { setData: (type: string, value: string) => values.set(type, value), getData: (type: string) => values.get(type) ?? "", effectAllowed: "none" } as unknown as DataTransfer;
}
const data = { path: "/z.png", name: "z.png", kind: "file", paths: ["/z.png", "/a.png"] };
beforeEach(() => { dragState.clear(); native.mockClear(); });
afterEach(() => { for (const call of native.mock.calls) call[1]?.({ result: "Cancelled" }); dragState.clear(); vi.unstubAllGlobals(); });

describe("shared HTML5 filesystem source protocol", () => {
  it("publishes ordered MIME, absolute URI paths and a live gesture for browser drops", () => {
    vi.stubGlobal("window", {}); const payload = transfer(); const onEnd = vi.fn(); const source = createHtml5FileDrag(onEnd);
    source.start({ dataTransfer: payload } as DragEvent, data);
    expect(payload.getData("application/x-explorer-paths")).toBe(JSON.stringify(data.paths));
    expect(payload.getData("text/uri-list")).toBe("file:///z.png\r\nfile:///a.png");
    expect(dragState.current?.paths).toEqual(data.paths); expect(native).not.toHaveBeenCalled();
    source.end(); expect(dragState.current).toBeNull(); expect(onEnd).toHaveBeenCalledOnce();
  });

  it("hands Linux app sources to native and preserves them through an early DOM dragend", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} }); const source = createHtml5FileDrag();
    const document = new EventTarget(); vi.stubGlobal("document", document);
    const stop = listenSidebarDragEnd({ quickAccess: () => undefined, isDragOver: () => false, reset: vi.fn() });
    source.start({ dataTransfer: transfer() } as DragEvent, data); const original = dragState.current;
    expect(native.mock.calls[0][0].item).toEqual(data.paths);
    document.dispatchEvent(new Event("dragstart"));
    document.dispatchEvent(new Event("dragend")); stop();
    source.end(); expect(dragState.current).toBe(original); expect(dragState.readCrossWindow()?.paths).toEqual(data.paths);
  });

  it("publishes the same native protocol for Miller/Recent single directory sources", () => {
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
