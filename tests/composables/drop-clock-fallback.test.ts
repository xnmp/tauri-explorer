import { afterEach, expect, it, vi } from "vitest";
import { branchDropPolicy, devDropPolicy, dropRejectedDomCases } from "../helpers/drop-policy";
import { dropElement } from "../helpers/drop-element";

const io = vi.hoisted(() => ({ start: vi.fn(), listen: vi.fn(), outcomes: [] as string[] }));
// Keep the clock, source, admission and destination code real. Only IPC and
// filesystem effects are replaced, as in the browser's rejected-start fixture.
vi.mock("$lib/api/common", () => ({
  isTauri: () => "__TAURI_INTERNALS__" in window,
  invoke: (command: string) => command === "native_file_drag_clock"
    ? Promise.resolve({ id: `browser:${performance.timeOrigin}`, now: performance.timeOrigin + performance.now() })
    : command === "start_file_drag" ? io.start() : Promise.resolve(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ listen: () => { io.listen(); return Promise.resolve(() => {}); } }),
}));
vi.mock("$lib/state/copy-operations", () => ({ copyFiles: async () => { io.outcomes.push("copy"); } }));
vi.mock("$lib/state/move-operations", () => ({ moveFiles: async () => { io.outcomes.push("move"); } }));

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(dropRejectedDomCases)("real clock: $source → $target / $modifier after browser startup and rejected native start", async c => {
  vi.resetModules(); localStorage.clear();
  io.listen.mockClear(); io.outcomes = [];
  io.start.mockReset().mockRejectedValue(new Error("Native file dragging is unavailable in the browser"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const win = new EventTarget();
  const doc = new EventTarget();
  const pane = dropElement("explorer-pane", { "data-pane-id": "owner" });
  const destination = "/destination";
  const hit = c.target === "folder" ? dropElement("entry-item directory", { "data-path": destination }, pane)
    : c.target === "breadcrumb" ? dropElement("crumb", { "data-path": destination }, pane)
    : dropElement("tab", { "data-tab-id": "destination-tab" });
  vi.stubGlobal("window", Object.assign(win, { devicePixelRatio: 1 }));
  vi.stubGlobal("document", Object.assign(doc, { elementFromPoint: () => hit, documentElement: { style: {} } }));
  const { useNativeDropHandler } = await import("$lib/composables/use-native-drop-handler");
  const { windowTabsManager } = await import("$lib/state/window-tabs.svelte");
  vi.spyOn(windowTabsManager, "getTabPath").mockReturnValue(destination);
  const service = useNativeDropHandler({ getActiveExplorer: () => ({ currentPath: destination }) as any, refreshAllPanes() {} });
  service.setup(); cleanup.push(service.cleanup);
  // The app starts as a browser, then a native boundary is injected. Wait for
  // listener setup, not an assumed clock state or a hand-fed native event.
  for (let i = 0; i < 100 && !io.listen.mock.calls.length; i++) await Promise.resolve();
  expect(io.listen).toHaveBeenCalledOnce();
  Object.assign(win, { __TAURI_INTERNALS__: { transformCallback: () => 1, unregisterCallback() {} } });
  const { dragState } = await import("$lib/state/drag.svelte");
  const { createHtml5FileDrag } = await import("$lib/state/html5-file-drag.svelte");
  const { useItemInteractions } = await import("$lib/composables/use-item-interactions.svelte");
  const { dropIntoDirectory } = await import("$lib/composables/use-dom-directory-drop");
  const { useDropTarget } = await import("$lib/composables/use-drop-target.svelte");
  const values = new Map<string, string>();
  const dt = { getData: (key: string) => values.get(key) ?? "", setData: (key: string, value: string) => values.set(key, value),
    get types() { return [...values.keys()]; }, effectAllowed: "all" } as unknown as DataTransfer;
  const event = (type: string) => {
    const e = Object.assign(new Event(type, { cancelable: true }), { dataTransfer: dt, ctrlKey: c.modifier === "ctrl", altKey: false, clientX: 0, clientY: 0 });
    Object.defineProperty(e, "target", { value: hit });
    return e as DragEvent;
  };
  const entry = { path: "/source/item", name: "item", kind: "file", size: 1, modified: "" } as const;
  const drag = c.source === "listing-file"
    ? useItemInteractions({ getExplorer: () => ({ getSelectedEntries: () => [entry], refresh() {} }) as any })
    : createHtml5FileDrag();
  if ("handleDragStart" in drag) drag.handleDragStart(event("dragstart"), entry, true);
  else drag.start(event("dragstart"), entry);
  for (let i = 0; i < 100 && dragState.current?.transport === "native-pending"; i++) await Promise.resolve();
  expect(dragState.current?.transport).toBeUndefined();
  const drop = event("drop");
  win.dispatchEvent(drop); // production capture admission precedes the component
  const completion = c.target === "folder"
    ? useDropTarget({ onRefresh() {} }).handleDrop(drop, { ...entry, path: destination, kind: "directory" })
    : dropIntoDirectory(drop, destination, c.target, { onRefresh() {} });
  if ("handleDragEnd" in drag) drag.handleDragEnd(); else drag.end();
  await completion;
  expect(branchDropPolicy(c).outcome).toBe(devDropPolicy(c));
  expect(io.outcomes).toEqual([branchDropPolicy(c).outcome]);
  expect(io.start).toHaveBeenCalledOnce();
  // A delayed second delivery must not repeat the transfer after dragend.
  await dropIntoDirectory(event("drop"), destination, c.target, { onRefresh() {} });
  expect(io.outcomes).toEqual([branchDropPolicy(c).outcome]);
});
