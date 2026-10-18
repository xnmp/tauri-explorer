import { platformCopyModifier, platformDropEffect, gtkDropCallback } from "../helpers/platform-drag-intent";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("$lib/state/drag-clock", async actual => ({ ...await actual<object>(), dragClock: {
  initialize: async () => {}, ready: true,
  stamp: () => ({ clockId: `browser:${performance.timeOrigin}`, at: Math.floor(performance.timeOrigin + performance.now()), uncertainty: 0 }),
} }));
import { outgoingFilesystemCases, dropStaleFilesCases, dropDeferredUriCases, dropVisibilityCases, dropUriCases, dropUriHtmlCases, dropVisibilities, dropCases, dropSources, dropTargets, dropDeliveryOrders, dropDeliveryCases, dropRejectedDomCases, dropModalCompletionCases, dropBoundaryCases, dropCrossWindowCases, dropLateDomCases, dropPathCases, dropTemporalCases, outgoingRecentCases, dropPlatforms, branchDropPolicy, devDropPolicy, nativeRoute, intendedDifferences, type DropCase, type Outcome } from "../helpers/drop-policy";
import { dropElement } from "../helpers/drop-element";

const io = vi.hoisted(() => ({ start: vi.fn(), listener: undefined as ((event: any) => void) | undefined,
  callbacks: new Map<number, Function>(), sequence: 0, outcomes: [] as string[], records: [] as { paths: readonly string[]; target?: string }[] }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<object>(), invoke: (command: string, args: any) =>
  command === "start_file_drag" ? io.start(args) : Promise.resolve(undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ listen: (_: string, fn: any) => { io.listener = fn; return Promise.resolve(() => {}); } }) }));
vi.mock("$lib/state/move-operations", () => ({ moveFiles: vi.fn(async (paths: string[], target: string) => { if (paths.length) { io.outcomes.push("move"); io.records.push({paths: [...paths], target}); } }) }));
vi.mock("$lib/state/copy-operations", () => ({ copyFiles: vi.fn(async (paths: string[], target: string) => { if (paths.length) { io.outcomes.push("copy"); io.records.push({paths: [...paths], target}); } }) }));
vi.mock("$lib/state/bookmarks.svelte", () => ({ bookmarksStore: {
  addBookmark: vi.fn((path: string) => { io.outcomes.push("pin"); io.records.push({paths: [path]}); }), reorderBookmarks: vi.fn(() => io.outcomes.push("reorder")),
} }));
vi.mock("$lib/state/terminal.svelte", () => ({ terminalPanelStore: { insertPaths: (paths: readonly string[]) => {
  io.outcomes.push("terminal-insertion"); io.records.push({ paths: [...paths] });
} } }));

let modules: any, peer: any;
let win: EventTarget, doc: EventTarget, hit: HTMLElement;
let cleanup: (() => void)[];
let sourcePath: string, destPath: string;
let observationTime = 0;
let matrixClock = 20_000_000_000_000;
let sourceNode: HTMLElement;
let sidebarOver = false;
let sourceEnd: (() => void) | undefined;
let recentSourceTransfer: DataTransfer | undefined;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function transfer(values: Record<string, string> = {}): DataTransfer {
  const data = new Map(Object.entries(values));
  return { getData: (type: string) => data.get(type) ?? "", setData: (type: string, value: string) => { data.set(type, value); }, get types() { return [...data.keys()]; }, effectAllowed: "all", dropEffect: "none" } as unknown as DataTransfer;
}
function event(type: string, dt: DataTransfer, c: DropCase, target = hit): DragEvent & { stopped: boolean } {
  if (type === "dragstart" && c.source === "recent") recentSourceTransfer = dt;
  const e = Object.assign(new Event(type, { cancelable: true }), { dataTransfer: dt, clientX: 30, clientY: 40,
    ctrlKey: c.modifier === "ctrl", altKey: c.modifier === "option", stopped: false });
  Object.defineProperty(e, "target", { value: target });
  const stop = e.stopImmediatePropagation.bind(e);
  e.stopImmediatePropagation = () => { e.stopped = true; stop(); };
  return e as unknown as DragEvent & { stopped: boolean };
}
function native(type: string, source: any, c: DropCase, observedAt?: number, completedGestureSequence?: number) {
  observationTime += 2;
  // GTK exports Recent's actual URI-list; Wry preserves the non-file URN.
  // No explicit native start ran, so Rust supplies no source provenance.
  const recentGtk = c.platform === "linux" && c.source === "recent";
  const paths = recentGtk ? [recentSourceTransfer!.getData("text/uri-list")] : [sourcePath];
  if (recentGtk) expect(paths[0]).toMatch(/^urn:tauri-explorer:drag:/);
  io.listener!({ payload: { type, paths, source: recentGtk ? null : source, position: { x: 60, y: 80 }, copyModifier: platformCopyModifier(c.platform === "linux"
    ? { platform: "linux", cachedModifiers: c.modifier === "ctrl" ? 4 : 0 }
    : c.platform === "mac" ? { platform: "mac", cachedModifiers: c.modifier === "option" ? 524288 : 0 }
    : { platform: "windows", keyState: c.modifier === "ctrl" ? 8 : 0 }), observedAt: observedAt ?? observationTime + 0.25, completedGestureSequence } });
}
function target(c: DropCase) {
  const pane = dropElement("explorer-pane", { "data-pane-id": "owner" });
  const access = dropElement("quick-access");
  const targets = {
    folder: dropElement("entry-item directory", { "data-path": destPath }, pane),
    breadcrumb: dropElement("crumb", { "data-path": destPath }, pane),
    tab: dropElement("tab", { "data-tab-id": "target-tab" }),
    bookmark: dropElement("bookmark-drop-target", { "data-path": destPath }, access),
    "quick-access": access,
    "sidebar-reorder": dropElement("bookmark-drop-target", { "data-path": destPath }, access),
    plugin: dropElement("plugin-file-view"),
    textarea: dropElement("textarea", {}, dropElement("modal-overlay")),
    "covered-pane": dropElement("content", { "data-current-path": destPath }, pane),
    "listing-background": dropElement("content", { "data-current-path": destPath }, pane),
    "miller-background": dropElement("miller-col", { "data-path": destPath }, pane),
    "plugin-view": dropElement("plugin-file-view"),
    terminal: dropElement("terminal-panel"),
  };
  return targets[c.target];
}
async function domDestination(e: DragEvent, c: DropCase) {
  const { directory, sidebar, folder } = modules;
  if (["quick-access", "bookmark", "sidebar-reorder"].includes(c.target)) {
    if (c.target === "sidebar-reorder" && c.source === "sidebar-bookmark") sidebar.dropBookmarkReorder(e, 0, 1);
    sidebar.dropOnQuickAccess(e); // real Quick Access ancestor receives a reorder too
  } else if (c.target === "folder") await folder.useDropTarget({ onRefresh: () => {} }).handleDrop(e, { path: destPath, kind: "directory" });
  else if (["breadcrumb", "tab", "listing-background", "miller-background", "covered-pane"].includes(c.target)) {
    await directory.dropIntoDirectory(e, destPath, c.target === "covered-pane" ? "listing-background" : c.target, { onRefresh: () => {} });
  }
}
function openCompletionModal(c: DropCase): void {
  if (!c.completionModal) return;
  const scope = c.completionModal === "window" ? null : { paneId: c.completionModal === "destination-pane" ? "owner" : "other", token: Symbol() };
  cleanup.push(modules.ownership.modalOwnership.registerSurface(() => {}, undefined, undefined, { scope }).release);
  modules.dialogs.dialogStore.isPaneBlocked.mockRestore();
}
const blockedSurface = (c: DropCase) => ["plugin-view", "textarea"].includes(c.target)
  || (c.target === "covered-pane" && (!c.completionModal || c.completionModal === "window" || c.completionModal === "destination-pane"));
async function run(c: DropCase): Promise<Outcome[]> {
  if (c.pathPair) { sourcePath = c.pathPair.source; destPath = c.pathPair.destination; }
  const sourceModules = c.window === "cross-window" ? peer : modules;
  hit = target(c);
  vi.spyOn(modules.dialogs.dialogStore, "isPaneBlocked").mockReturnValue(c.target === "covered-pane");
  const handler = vi.fn((paths: readonly string[], kind: string) => { io.outcomes.push(`plugin:${kind}`); io.records.push({paths: [...paths]}); });
  if (c.target === "plugin") cleanup.push(modules.targets.fileDropTargets.register(hit, handler));
  let dt = transfer();
  const fileSource = c.source.startsWith("listing-") || c.source.startsWith("miller-") || c.source === "recent";
  const entry = { path: sourcePath, name: "item", kind: c.source.endsWith("-folder") || c.source === "recent" ? "directory" : "file", size: 1, modified: "" };
  if (fileSource && c.transport === "dom-only" && c.platform !== "linux") {
    const drag = c.source === "recent" ? sourceModules.sidebarPointer.useSidebarDrag() : sourceModules.pointer.usePointerDrag({ getExplorer: () => ({ getSelectedEntries: () => [entry], currentPath: destPath, entryMeta: new Map([[entry.path, { depth: 0 }]]) }) });
    if (c.source === "recent") drag.handlePointerDown({ button: 0, preventDefault() {}, clientX: 10, clientY: 10 } as any, entry.path, entry.name);
    else drag.handlePointerDown({ button: 0, preventDefault() {}, clientX: 10, clientY: 10 } as any, entry, true);
    win.dispatchEvent(Object.assign(new Event("mousemove"), { clientX: 30, clientY: 40 }));
    openCompletionModal(c);
    win.dispatchEvent(Object.assign(new Event("mouseup"), { clientX: 30, clientY: 40, ctrlKey: c.modifier === "ctrl", altKey: c.modifier === "option" }));
    await flush();
    return (io.outcomes.length ? io.outcomes : blockedSurface(c) ? ["blocked"] : ["ignored"]) as Outcome[];
  }
  if (fileSource && c.source !== "recent" && c.transport === "native-accepted" && c.platform !== "linux") {
    // Actual macOS/Windows source: pointer drag exits the client viewport and
    // hands the same gesture to the native source boundary.
    const drag = sourceModules.pointer.usePointerDrag({ getExplorer: () => ({ getSelectedEntries: () => [entry], currentPath: destPath, entryMeta: new Map([[entry.path, { depth: 0 }]]) }) });
    drag.handlePointerDown({ button: 0, preventDefault() {}, clientX: 10, clientY: 10 } as any, entry, true);
    win.dispatchEvent(Object.assign(new Event("mousemove"), { clientX: -10, clientY: 40 }));
    await flush();
    const source = sourceModules.drag.dragState.current;
    expect(io.start.mock.calls.at(-1)![0].source.nativeCopyPolicy).toBeUndefined();
    dt = transfer({ "application/x-explorer-path": sourcePath, "application/x-explorer-kind": entry.kind,
      "application/x-explorer-session": source.sessionId });
  } else   if (fileSource) {
    if (c.transport === "dom-only") delete (win as any).__TAURI_INTERNALS__;
    const drag = c.source.startsWith("listing-") && c.platform === "linux" ? sourceModules.items.useItemInteractions({ getExplorer: () => ({ getSelectedEntries: () => [entry], refresh() {} }) })
      : sourceModules.html.createHtml5FileDrag(() => {}, c.source === "recent" ? "link" : "modifier");
    const start = event("dragstart", dt, c, sourceNode);
    if (c.source.startsWith("listing-") && c.platform === "linux") drag.handleDragStart(start, entry, true);
    else drag.start(start, entry);
    sourceEnd = c.source.startsWith("listing-") && c.platform === "linux" ? drag.handleDragEnd : drag.end;
    doc.dispatchEvent(start);
    if (c.transport !== "dom-only" && c.platform !== "linux") void sourceModules.external.startExternalDrag([sourcePath]);
    await flush();
  } else if (c.source === "sidebar-bookmark") dt = transfer({ "application/x-bookmark-index": "0" });
  else if (c.source === "external-file") dt = transfer({ Files: "" });
  else dt = transfer({ "text/plain": "description", ...(c.source === "plugin-surface" ? { "application/x-plugin-item": "item" } : {}) });
  // Targets see a distinct protected data store, never the dragstart object.
  if (fileSource) {
    const visibleTypes = c.visibility === "stripped"
      ? ["text/uri-list", "text/html"].filter(type => dt.types.includes(type))
      : [...dt.types];
    const projected = transfer(Object.fromEntries(visibleTypes.map(type =>
      [type, dt.getData(type)])));
    projected.effectAllowed = dt.effectAllowed;
    dt = projected;
  }
  if (c.source === "external-uri" || (c.source === "external-file" && c.staleGesture)) {
    if (c.staleGesture) {
      const state = c.staleGesture === "cross-window" ? peer.drag.dragState : modules.drag.dragState;
      state.start({ path: sourcePath, name: "item", kind: "file", html5: true,
        nativeCopyPolicy: "modifier" });
      if (c.staleGesture === "retired") state.endHtml5(state.current);
      if (c.staleGesture === "wrong-clock") vi.stubGlobal("performance", { timeOrigin: matrixClock + 1, now: () => 0 });
    }
    // Even a matching filesystem URI is not proof of this app's gesture.
    const uri = (c.staleGesture === "mismatched-session" ? "# explorer-drag-session=unrelated\r\n" : "") + "file://" + encodeURI(sourcePath);
    dt = transfer(c.source === "external-file" ? { Files: "", ...(c.filesUri ? { "text/uri-list": uri, ...(c.uriHtml ? { "text/html": "<a>external file</a>" } : {}) } : {}) }
      : { "text/uri-list": uri, ...(c.uriHtml ? { "text/html": "<a>external</a>" } : {}) });
  }
  let delayedObservation: number | undefined;
  if (c.lifetime === "expired") {
    delayedObservation = observationTime + 1.25;
    observationTime += 2; sourceEnd?.(); sourceEnd = undefined;
    for (let i = 0; i < 8; i++) {
      observationTime += 2;
      const successor = modules.html.createHtml5FileDrag();
      successor.start(event("dragstart", transfer(), c), entry); await flush();
      observationTime += 2; successor.end();
    }
  }
  const source = c.source === "external-file" || c.transport === "native-rejected" ? null : { ...sourceModules.drag.dragState.current };
  const capturedAt = delayedObservation ?? observationTime + 0.25;
  const deliverNative = async () => {
    if (nativeRoute(c)) {
      native("enter", source, c, capturedAt); native("drop", source, c, capturedAt); await flush();
      // Wry may intercept GTK delivery entirely. A later DOM callback must
      // not mask a lost native Recent completion on its receiving surfaces.
      if (c.platform === "linux" && c.source === "recent" && !c.completionModal
          && !["dom-first", "native-late-after-dragend"].includes(c.deliveryOrder ?? "")) {
        const expected = branchDropPolicy(c).outcome;
        if (expected === "pin" || expected === "plugin:pane") expect(io.outcomes).toEqual([expected]);
      }
    }
  };
  const over = event("dragover", dt, c); win.dispatchEvent(over);
  if (c.target === "breadcrumb") {
    // The component-used hover gate is exercised even if capture admits it.
    const crumbOver = event("dragover", dt, c);
    modules.directory.dragOverDirectory(crumbOver, "move");
    if (fileSource && c.transport === "native-rejected" && c.deliveryOrder === "dom-only") expect(crumbOver.defaultPrevented).toBe(true);
  }
  sidebarOver = !!hit.closest(".quick-access");
  openCompletionModal(c);
  const end = () => {
    observationTime += 2;
    doc.dispatchEvent(event("dragend", transfer(), c, sourceNode));
    sourceEnd?.(); sourceEnd = undefined;
  };
  const drop = event("drop", dt, c);
  const deliverDom = async () => {
    win.dispatchEvent(drop);
    if (c.source === "text" || c.source === "plugin-surface") {
      expect(over.defaultPrevented).toBe(false); expect(drop.defaultPrevented).toBe(false); expect(drop.stopped).toBe(false);
    }
    if (!drop.stopped) {
      const nonfile = c.source === "text" || c.source === "plugin-surface";
      if (nonfile && ["plugin", "plugin-view"].includes(c.target)) io.outcomes.push("plugin:dom");
      else if (nonfile && c.target === "textarea" && !drop.defaultPrevented && !over.defaultPrevented) io.outcomes.push("text-insertion");
      else await domDestination(drop, c);
    }
    await flush();
    if (c.source === "external-uri") {
      expect(drop.defaultPrevented).toBe(false);
      expect(drop.stopped).toBe(false);
      if (!c.staleGesture || c.staleGesture === "retired" || c.staleGesture === "wrong-clock") expect(over.defaultPrevented).toBe(false);
    }
  };
  if (c.completionPath === "sidebar-dragend") end();
  else if (c.deliveryOrder === "native-late-after-dragend") { await deliverDom(); end(); await deliverNative(); }
  else if (c.deliveryOrder === "dom-after-dragend") { end(); await deliverDom(); }
  else if (c.deliveryOrder === "dom-first") { await deliverDom(); await deliverNative(); end(); }
  else { await deliverNative(); await deliverDom(); end(); }
  if (!io.outcomes.length && blockedSurface(c) && drop.stopped) io.outcomes.push("blocked");
  // A file's native/pointer blocked result has no DOM outcome to inspect.
  if (!io.outcomes.length && nativeRoute(c) && blockedSurface(c)) io.outcomes.push("blocked");
  if (!io.outcomes.length && modules.toast.toastStore.toasts.some((toast: {message: string}) => /gesture identity expired/.test(toast.message))) io.outcomes.push("blocked");
  if (!io.outcomes.length) io.outcomes.push("ignored");
  return io.outcomes as Outcome[];
}

describe.each(dropPlatforms)("differential drop outcomes: %s", platform => {
  beforeAll(async () => {
    localStorage.clear();
    vi.resetModules(); vi.stubGlobal("navigator", { platform: platform === "mac" ? "MacIntel" : platform === "windows" ? "Win32" : "Linux" });
    const names = {
      dispatch: "$lib/state/dispatch-file-drop", native: "$lib/composables/use-native-drop-handler", html: "$lib/state/html5-file-drag.svelte", items: "$lib/composables/use-item-interactions.svelte",
      pointer: "$lib/composables/use-pointer-drag.svelte", external: "$lib/composables/use-external-drag.svelte", drag: "$lib/state/drag.svelte",
      sidebarPointer: "$lib/composables/use-sidebar-drag.svelte",
      sidebarEnd: "$lib/composables/use-sidebar-drag-end", targets: "$lib/state/file-drop-targets.svelte", dialogs: "$lib/state/dialogs.svelte", ownership: "$lib/state/modal-ownership.svelte",
      toast: "$lib/state/toast.svelte", tabs: "$lib/state/window-tabs.svelte", directory: "$lib/composables/use-dom-directory-drop", sidebar: "$lib/composables/use-sidebar-file-drop", folder: "$lib/composables/use-drop-target.svelte",
    };
    const load = async () => Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await import(name)])));
    peer = await load(); vi.resetModules(); modules = await load();
  });
  beforeEach(async () => {
    observationTime = matrixClock += 100;
    vi.spyOn(Date, "now").mockImplementation(() => observationTime);
    vi.stubGlobal("performance", { timeOrigin: matrixClock, now: () => observationTime - matrixClock });
    cleanup = []; sourceEnd = undefined; recentSourceTransfer = undefined; sourceNode = dropElement(); sidebarOver = false; io.outcomes = []; io.records = []; io.callbacks.clear(); io.start.mockReset().mockResolvedValue(undefined);
    // Retain the shared gesture history between live peer modules. Clearing
    // storage alone would fabricate a quota-loss boundary while leaving one
    // peer's local ordinals ahead of the other, rather than a fresh window.
    modules.drag.dragState.clear(); peer.drag.dragState.clear(); modules.toast.toastStore.clear();
    win = new EventTarget(); doc = new EventTarget();
    sourcePath = platform === "windows" ? "C:/source/item" : "/source/item";
    destPath = platform === "windows" ? "C:/destination" : "/destination";
    vi.stubGlobal("window", Object.assign(win, { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2, __TAURI_INTERNALS__: {
      transformCallback: (fn: Function) => { const id = ++io.sequence; io.callbacks.set(id, fn); return id; }, unregisterCallback: (id: number) => io.callbacks.delete(id),
    } }));
    vi.stubGlobal("document", Object.assign(doc, { elementFromPoint: () => hit, documentElement: { style: {} },
      createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {}, style: {} } }));
    vi.stubGlobal("DataTransfer", function () { return transfer(); });
    vi.stubGlobal("DragEvent", function (type: string, init: DragEventInit) {
      const { bubbles, cancelable, ...data } = init;
      return Object.assign(new Event(type, { bubbles, cancelable }), data);
    });
    vi.spyOn(modules.tabs.windowTabsManager, "getTabPath").mockImplementation(() => destPath);
    const service = modules.native.useNativeDropHandler({ getActiveExplorer: () => ({ currentPath: destPath }), refreshAllPanes() {} });
    service.setup(); cleanup.push(service.cleanup);
    cleanup.push(modules.sidebarEnd.listenSidebarDragEnd({
      quickAccess: () => hit?.closest(".quick-access") ?? undefined,
      isDragOver: () => sidebarOver, reset: () => { sidebarOver = false; },
    }));
    await flush();
  });
  afterEach(async () => {
    sourceEnd?.();
    for (const args of io.start.mock.calls) {
      const callback = io.callbacks.get(args[0].onEvent.id);
      callback?.({ index: 0, message: { result: "Cancelled" } });
    }
    cleanup.reverse().forEach(fn => fn());
    await flush();
    modules.drag.dragState.finish(modules.drag.dragState.current, true);
    peer.drag.dragState.finish(peer.drag.dragState.current, true);
    vi.restoreAllMocks();
  });
  it.each([...dropVisibilityCases, ...dropUriCases, ...dropUriHtmlCases, ...dropStaleFilesCases].filter(c => c.platform === platform))("$source → $target / $modifier / $transport / $deliveryOrder / $lifetime / $window / $pathPair.id / $visibility / html:$uriHtml / stale:$staleGesture / Files+URI:$filesUri", async c => {
    if (c.transport === "native-rejected") { io.start.mockRejectedValue("unavailable"); vi.spyOn(console, "warn").mockImplementation(() => {}); }
    const policy = branchDropPolicy(c);
    if (!policy.difference) expect(policy.outcome).toBe(devDropPolicy(c));
    const outcomes = await run(c);
    // Also catches duplicate transfer/pinning/delivery across native and DOM.
    expect(outcomes).toEqual([policy.outcome]);
    for (const record of io.records) {
      expect(record.paths).toEqual([sourcePath]);
      if (record.target) expect(record.target).toBe(destPath);
    }
  });
  it("native handoff moves without a modifier even when the source advertises Copy only", async () => {
    const c: DropCase = { platform, source: "miller-file", target: "folder", modifier: "none", transport: "native-accepted" };
    hit = target(c);
    modules.drag.dragState.start({ path: sourcePath, name: "item", kind: "file", nativeCopyPolicy: "modifier" });
    const source = modules.drag.dragState.current;
    const copyModifier = platformCopyModifier(platform === "linux"
      ? { platform, cachedModifiers: 0 }
      : platform === "mac" ? { platform, cachedModifiers: 0 }
      : { platform, keyState: 0 });
    io.listener!({ payload: { type: "drop", paths: [sourcePath], source, copyModifier,
      observedAt: observationTime + 0.25, position: { x: 60, y: 80 } } });
    await flush();
    await vi.waitFor(() => expect(io.outcomes).toEqual(["move"]));
  });
  it.runIf(platform === "linux")("Recent X11 action set without Copy still delivers to the plugin", async () => {
    // The actual GTK callback has no action-set gate: Recent offers Link, without Copy.
    expect(gtkDropCallback(true)).toEqual({ delivered: true, domFallback: false, finished: true });
    expect(await run({ platform, source: "recent", target: "plugin", modifier: "none", transport: "native-accepted" })).toEqual(["plugin:pane"]);
  });
  it.runIf(platform === "linux")("GTK without URI-list lets bookmark reorder reach its DOM owner", async () => {
    const callback = gtkDropCallback(false);
    expect(callback).toEqual({ delivered: false, domFallback: true, finished: false });
    if (callback.domFallback) {
      expect(await run({ platform, source: "sidebar-bookmark", target: "sidebar-reorder", modifier: "none", transport: "dom-only" })).toEqual(["reorder"]);
    }
  });
  it.runIf(platform !== "linux")("incoming external drop acknowledges Copy while frontend intent stays Move", async () => {
    for (const phase of ["enter", "over", "drop"] as const) {
      expect(platformDropEffect(platform as "mac" | "windows", phase)).toBe(1);
    }
    expect(await run({ platform, source: "external-file", target: "folder", modifier: "none", transport: "native-accepted" })).toEqual(["move"]);
  });
  it.each([false, true])("native handoff derives intent from the platform modifier / $0", async copying => {
    const c: DropCase = { platform, source: "miller-file", target: "folder", modifier: copying ? platform === "mac" ? "option" : "ctrl" : "none", transport: "native-accepted" };
    hit = target(c);
    modules.drag.dragState.start({ path: sourcePath, name: "item", kind: "file", nativeCopyPolicy: "modifier" });
    const source = modules.drag.dragState.current;
    native("enter", source, { ...c, modifier: copying ? "none" : platform === "mac" ? "option" : "ctrl" });
    native("drop", source, c);
    await flush();
    await vi.waitFor(() => expect(io.outcomes).toEqual([copying ? "copy" : "move"]));
  });
  it.runIf(platform === "linux").each(
    (["listing-folder", "miller-folder"] as const).flatMap(source =>
      (["before-escape", "before-source-end", "after-source-end"] as const).map(rejection => ({ source, rejection }))),
  )("Escape-cancelled sidebar gesture never pins / $source / $rejection", async ({ source: sourceKind, rejection }) => {
    const c: DropCase = { platform, source: sourceKind, target: "quick-access", modifier: "none", transport: "native-rejected" };
    hit = target(c); sidebarOver = true;
    let rejectStart!: (reason: string) => void;
    io.start.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectStart = reject; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    hit.dispatchEvent = replay => { Object.defineProperty(replay, "target", { value: hit }); return win.dispatchEvent(replay); };
    win.addEventListener("drop", e => { void domDestination(e as DragEvent, c); });
    const entry = { path: sourcePath, name: "item", kind: "directory" };
    const source = sourceKind === "listing-folder"
      ? modules.items.useItemInteractions({ getExplorer: () => ({ getSelectedEntries: () => [entry], refresh() {} }) })
      : modules.html.createHtml5FileDrag();
    const start = event("dragstart", transfer(), c, sourceNode);
    if (sourceKind === "listing-folder") source.handleDragStart(start, entry, true); else source.start(start, entry);
    sourceEnd = sourceKind === "listing-folder" ? source.handleDragEnd : source.end;
    doc.dispatchEvent(start);
    if (rejection === "before-escape") { rejectStart("unavailable"); await flush(); }
    win.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    // Escape ends the browser gesture without a Drop. With an already settled
    // start, model its dragleave clearing hover and dragend's zero coordinates.
    // Pending rows deliberately retain stale hover to attack synthetic replay.
    if (rejection === "before-escape") sidebarOver = false;
    const end = event("dragend", transfer(), c, sourceNode);
    Object.assign(end, { clientX: 0, clientY: 0 });
    doc.dispatchEvent(end);
    if (rejection === "before-source-end") { rejectStart("unavailable"); await flush(); }
    sourceEnd!(); sourceEnd = undefined;
    if (rejection === "after-source-end") rejectStart("unavailable");
    await flush();
    expect(io.outcomes).toEqual([]);
    expect(io.records).toEqual([]);
  });
  it.runIf(platform === "linux").each(
    (["listing-folder", "miller-folder"] as const).flatMap(source =>
      (["before-dragend", "after-dragend"] as const).flatMap(removal =>
        (["before-source-end", "after-source-end"] as const).map(rejection => ({ source, removal, rejection })))),
  )("destination-change cancelled sidebar drop never pins / $source / $removal / $rejection", async ({ source: sourceKind, removal, rejection }) => {
    const c: DropCase = { platform, source: sourceKind, target: "bookmark", modifier: "none", transport: "native-rejected" };
    hit = target(c); sidebarOver = true;
    const bookmark = hit;
    const access = bookmark.closest(".quick-access")!;
    access.dispatchEvent = replay => { Object.defineProperty(replay, "target", { value: access }); return win.dispatchEvent(replay); };
    let rejectStart!: (reason: string) => void;
    io.start.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectStart = reject; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    win.addEventListener("drop", e => { void domDestination(e as DragEvent, c); });
    const entry = { path: sourcePath, name: "item", kind: "directory" };
    const source = sourceKind === "listing-folder"
      ? modules.items.useItemInteractions({ getExplorer: () => ({ getSelectedEntries: () => [entry], refresh() {} }) })
      : modules.html.createHtml5FileDrag();
    const start = event("dragstart", transfer(), c, sourceNode);
    if (sourceKind === "listing-folder") source.handleDragStart(start, entry, true); else source.start(start, entry);
    sourceEnd = sourceKind === "listing-folder" ? source.handleDragEnd : source.end;
    doc.dispatchEvent(start);
    win.dispatchEvent(event("drop", start.dataTransfer!, c));
    const removeBookmark = () => { Object.defineProperty(bookmark, "isConnected", { value: false }); };
    if (removal === "before-dragend") removeBookmark();
    doc.dispatchEvent(event("dragend", transfer(), c, sourceNode));
    if (removal === "after-dragend") removeBookmark();
    if (rejection === "before-source-end") { rejectStart("unavailable"); await flush(); }
    sourceEnd!(); sourceEnd = undefined;
    if (rejection === "after-source-end") rejectStart("unavailable");
    await flush();
    expect(modules.toast.toastStore.toasts.some((toast: { message: string }) => /destination changed/.test(toast.message))).toBe(true);
    expect(io.outcomes).toEqual([]);
    expect(io.records).toEqual([]);
  });
  // #1101: Linux can deliver only dragend over Quick Access while the native
  // start is pending. A later rejection replays the pin only for a gesture that
  // completed on that live Quick Access target.
  async function pendingQuickAccessGesture(sourceKind: "listing-folder" | "miller-folder" | "miller-file") {
    const c: DropCase = { platform, source: sourceKind, target: "quick-access", modifier: "none", transport: "native-rejected" };
    hit = target(c); sidebarOver = true;
    let rejectStart!: (reason: string) => void, acceptStart!: () => void;
    io.start.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { rejectStart = reject; acceptStart = resolve; }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    win.addEventListener("drop", e => { void domDestination(e as DragEvent, c); });
    const entry = { path: sourcePath, name: "item", kind: sourceKind === "miller-file" ? "file" : "directory" };
    const source = sourceKind === "listing-folder"
      ? modules.items.useItemInteractions({ getExplorer: () => ({ getSelectedEntries: () => [entry], refresh() {} }) })
      : modules.html.createHtml5FileDrag();
    const start = event("dragstart", transfer(), c, sourceNode);
    if (sourceKind === "listing-folder") source.handleDragStart(start, entry, true); else source.start(start, entry);
    sourceEnd = sourceKind === "listing-folder" ? source.handleDragEnd : source.end;
    doc.dispatchEvent(start);
    await flush();
    // A completed gesture's dragend reports the negotiated effect; a cancelled
    // one (Escape, release outside any target) reports "none".
    const endEvent = (dropEffect = "copy") => {
      const dt = transfer(); (dt as { dropEffect: string }).dropEffect = dropEffect;
      return event("dragend", dt, c, sourceNode);
    };
    const dragEnd = (dropEffect?: string) => doc.dispatchEvent(endEvent(dropEffect));
    const endSource = () => { sourceEnd!(); sourceEnd = undefined; };
    return { c, start, endEvent, dragEnd, endSource, reject: () => rejectStart("unavailable"), accept: () => acceptStart() };
  }
  const pendingSources = ["listing-folder", "miller-folder"] as const;
  it.runIf(platform === "linux").each(pendingSources.flatMap(source =>
    (["before-source-end", "after-source-end"] as const).map(rejection => ({ source, rejection }))),
  )("dragend-only Quick Access completion pins once after late native rejection / $source / $rejection", async ({ source, rejection }) => {
    const gesture = await pendingQuickAccessGesture(source);
    gesture.dragEnd();
    expect(io.outcomes).toEqual([]);
    if (rejection === "before-source-end") { gesture.reject(); await flush(); }
    gesture.endSource();
    if (rejection === "after-source-end") gesture.reject();
    await flush();
    expect(io.outcomes).toEqual(["pin"]);
    expect(io.records).toEqual([{ paths: [sourcePath] }]);
    expect(io.start).toHaveBeenCalledTimes(1);
  });
  it.runIf(platform === "linux").each(pendingSources)("rejection before dragend still pins exactly once / %s", async source => {
    const gesture = await pendingQuickAccessGesture(source);
    gesture.reject(); await flush();
    gesture.dragEnd(); gesture.endSource(); await flush();
    expect(io.outcomes).toEqual(["pin"]);
    expect(io.records).toEqual([{ paths: [sourcePath] }]);
  });
  it.runIf(platform === "linux").each(pendingSources)("accepted native start after dragend-only completion pins nothing / %s", async source => {
    const gesture = await pendingQuickAccessGesture(source);
    gesture.dragEnd(); gesture.accept(); await flush(); gesture.endSource(); await flush();
    expect(io.outcomes).toEqual([]);
  });
  it.runIf(platform === "linux").each(pendingSources.flatMap(source =>
    (["cancelled-drop-effect", "escape-keydown"] as const).map(signal => ({ source, signal }))),
  )("a cancelled gesture ending at a Quick Access point is not pinned by a late rejection / $source / $signal", async ({ source, signal }) => {
    const gesture = await pendingQuickAccessGesture(source);
    // The end point is still inside Quick Access with stale hover: only the
    // captured cancellation can refuse the replay. GTK grabs the keyboard
    // during a drag, so the dragend effect alone must suffice.
    if (signal === "escape-keydown") win.dispatchEvent(Object.assign(new Event("keydown"), { key: "Escape" }));
    gesture.dragEnd(signal === "cancelled-drop-effect" ? "none" : "copy");
    gesture.reject(); await flush(); gesture.endSource(); await flush();
    expect(io.outcomes).toEqual([]);
    expect(io.records).toEqual([]);
  });
  it.runIf(platform === "linux").each(pendingSources.flatMap(source =>
    (["disconnected", "row-removed", "replaced", "reowned"] as const).map(change => ({ source, change }))),
  )("Quick Access destination $change before late rejection pins nothing / $source", async ({ source, change }) => {
    const gesture = await pendingQuickAccessGesture(source);
    const access = hit;
    const row = dropElement("bookmark-drop-target", { "data-path": destPath }, access);
    (doc as any).elementFromPoint = () => row;
    gesture.dragEnd();
    if (change === "disconnected") Object.defineProperty(access, "isConnected", { value: false });
    else if (change === "row-removed") Object.defineProperty(row, "isConnected", { value: false });
    else if (change === "replaced") hit = dropElement("quick-access");
    else cleanup.push(modules.targets.fileDropTargets.register(access, vi.fn()));
    gesture.reject(); await flush(); gesture.endSource(); await flush();
    expect(io.outcomes).toEqual([]);
    expect(io.records).toEqual([]);
    if (change !== "reowned") expect(modules.toast.toastStore.toasts.some((toast: { message: string }) => /destination changed/.test(toast.message))).toBe(true);
  });
  it.runIf(platform === "linux")("a file's dragend-only end on Quick Access defers nothing and reports no destination change", async () => {
    const gesture = await pendingQuickAccessGesture("miller-file");
    gesture.dragEnd();
    hit = dropElement("quick-access");
    gesture.reject(); await flush(); gesture.endSource(); await flush();
    expect(io.outcomes).toEqual([]);
    expect(modules.toast.toastStore.toasts).toEqual([]);
  });
  it.runIf(platform === "linux").each(pendingSources)("a window modal opened before the late rejection blocks the deferred pin / %s", async source => {
    const gesture = await pendingQuickAccessGesture(source);
    gesture.dragEnd();
    cleanup.push(modules.ownership.modalOwnership.registerSurface(() => {}, undefined, undefined, { scope: null }).release);
    gesture.reject(); await flush(); gesture.endSource(); await flush();
    expect(io.outcomes).toEqual([]);
  });
  it.runIf(platform === "linux").each(pendingSources.flatMap(source =>
    (["elsewhere", "zero-coordinates"] as const).map(point => ({ source, point }))),
  )("stale Quick Access hover without an end point there pins nothing after late rejection / $source / $point", async ({ source, point }) => {
    const gesture = await pendingQuickAccessGesture(source);
    // A zero-coordinate end must not be hit-tested at all: the stub would
    // still answer with Quick Access.
    if (point === "elsewhere") {
      const outside = dropElement("entry-item directory", { "data-path": destPath }, dropElement("explorer-pane"));
      (doc as any).elementFromPoint = () => outside;
    }
    const end = gesture.endEvent();
    if (point === "zero-coordinates") Object.assign(end, { clientX: 0, clientY: 0 });
    doc.dispatchEvent(end);
    gesture.reject(); await flush(); gesture.endSource(); await flush();
    expect(io.outcomes).toEqual([]);
  });
  it.runIf(platform === "linux").each(pendingSources)("a late readable Drop after the deferred pin cannot pin again / %s", async source => {
    const gesture = await pendingQuickAccessGesture(source);
    gesture.dragEnd(); gesture.reject(); await flush();
    expect(io.outcomes).toEqual(["pin"]);
    win.dispatchEvent(event("drop", gesture.start.dataTransfer!, gesture.c)); await flush();
    gesture.endSource(); await flush();
    expect(io.outcomes).toEqual(["pin"]);
  });
  it.runIf(platform === "linux").each(pendingSources)("a deferred bookmark Drop cancelled by row removal is not re-pinned by dragend / %s", async source => {
    const gesture = await pendingQuickAccessGesture(source);
    const access = hit;
    const bookmark = dropElement("bookmark-drop-target", { "data-path": destPath }, access);
    hit = bookmark;
    win.dispatchEvent(event("drop", gesture.start.dataTransfer!, { ...gesture.c, target: "bookmark" }));
    // The row vanished: the end point now resolves to the live Quick Access root.
    Object.defineProperty(bookmark, "isConnected", { value: false });
    (doc as any).elementFromPoint = () => access;
    gesture.dragEnd();
    gesture.reject(); await flush(); gesture.endSource(); await flush();
    expect(modules.toast.toastStore.toasts.some((toast: { message: string }) => /destination changed/.test(toast.message))).toBe(true);
    expect(io.outcomes).toEqual([]);
  });
  it.runIf(platform === "linux").each(pendingSources)("disposing the sidebar abandons a deferred pin / %s", async source => {
    const gesture = await pendingQuickAccessGesture(source);
    gesture.dragEnd();
    cleanup.splice(1, 1)[0]();
    gesture.reject(); await flush(); gesture.endSource(); await flush();
    expect(io.outcomes).toEqual([]);
  });
  it.each(dropDeferredUriCases.filter(c => c.platform === platform))("deferred URI drop after dragend / $target / $visibility", async c => {
    delete (win as any).__TAURI_INTERNALS__;
    hit = target(c);
    if (c.target === "plugin") cleanup.push(modules.targets.fileDropTargets.register(hit, (paths: readonly string[]) => {
      io.outcomes.push("plugin:pane"); io.records.push({ paths: [...paths] });
    }));
    const source = modules.html.createHtml5FileDrag();
    const startData = transfer();
    source.start(event("dragstart", startData, c), { path: sourcePath, name: "item", kind: "file" });
    sourceEnd = source.end;
    const lease = modules.drag.dragState.beginNative(modules.drag.dragState.current);
    const dt = c.visibility === "stripped" ? transfer({ "text/uri-list": startData.getData("text/uri-list"), "text/html": startData.getData("text/html") }) : startData;
    hit.dispatchEvent = e => {
      Object.defineProperty(e, "target", { value: hit });
      return win.dispatchEvent(e);
    };
    win.addEventListener("drop", e => { void domDestination(e as DragEvent, c); });
    win.dispatchEvent(event("drop", dt, c));
    source.end(); sourceEnd = undefined;
    observationTime += 2;
    lease.failed();
    await vi.waitFor(() => expect(io.outcomes.length).toBe(1));
    expect(io.outcomes).toEqual([branchDropPolicy(c).outcome]);
    expect(io.records[0].paths).toEqual([sourcePath]);
  });
  it.runIf(platform === "linux").each(dropVisibilities.flatMap(visibility =>
    (["empty", "unrelated", "mixed"] as const).flatMap(payload =>
      (["enter-only", "enter-and-drop"] as const).map(delivery => ({ visibility, payload, delivery }))))
  )("unresolved GTK $payload / $delivery preserves Recent DOM delivery / $visibility", async ({ visibility, payload, delivery }) => {
    const c: DropCase = { platform, source: "recent", target: "plugin", modifier: "none", transport: "dom-only", visibility };
    hit = target(c);
    const handler = vi.fn();
    cleanup.push(modules.targets.fileDropTargets.register(hit, handler));
    const source = modules.html.createHtml5FileDrag(() => {}, "link");
    const startData = transfer();
    source.start(event("dragstart", startData, c), { path: sourcePath, name: "item", kind: "directory" });
    sourceEnd = source.end;
    const dt = visibility === "stripped" ? transfer({ "text/uri-list": startData.getData("text/uri-list"), "text/html": startData.getData("text/html") }) : startData;
    const rawPaths = payload === "empty" ? [] : payload === "unrelated" ? ["urn:tauri-explorer:drag:unrelated"]
      : [startData.getData("text/uri-list"), "invalid"];
    for (const type of delivery === "enter-only" ? ["enter"] : ["enter", "drop"]) {
      io.listener!({ payload: { type, paths: rawPaths, source: null, observedAt: observationTime + 0.25, position: { x: 60, y: 80 } } });
      await flush();
    }
    expect(handler).not.toHaveBeenCalled();
    win.dispatchEvent(event("drop", dt, c));
    await flush();
    expect(handler).toHaveBeenCalledExactlyOnceWith([sourcePath], "pane");
  });
  it.each(["html5", "pointer"] as const)("%s completion receipt survives async delivery, finish, and a receiver-window change", async transport => {
    modules.drag.dragState.start({ path: sourcePath, name: "item", kind: "file", html5: transport === "html5" });
    const source = { ...modules.drag.dragState.current };
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    const handler = vi.fn(() => pending);
    const registered = { type: "plugin", registration: { live: () => true, enabled: () => true, handler } };
    const first = modules.dispatch.dispatchFileDrop(registered, [sourcePath], "pane", source);
    const duplicate = peer.dispatch.dispatchFileDrop(registered, [sourcePath], "pane", source);
    settle(); await Promise.all([first, duplicate]);
    await modules.dispatch.dispatchFileDrop(registered, [sourcePath], "pane", source);
    await peer.dispatch.dispatchFileDrop(registered, [sourcePath], "pane", source);
    expect(handler).toHaveBeenCalledExactlyOnceWith([sourcePath], "pane");
  });
  it.each(dropModalCompletionCases.filter(c => c.platform === platform))("live modal: $completionModal / $source → $target / $deliveryOrder / $transport / $completionPath", async c => {
    if (c.transport === "native-rejected") { io.start.mockRejectedValue("unavailable"); vi.spyOn(console, "warn").mockImplementation(() => {}); }
    const outcomes = await run(c);
    const covered = c.completionModal === "window" || (c.completionModal === "destination-pane" &&
      ["folder", "breadcrumb", "covered-pane", "listing-background", "miller-background"].includes(c.target));
    if (covered) expect(io.records).toEqual([]);
    else expect(outcomes).toEqual([branchDropPolicy({ ...c, target: c.target === "covered-pane" ? "listing-background" : c.target }).outcome]);
    expect(io.records.length).toBeLessThanOrEqual(1);
  });
  it.each(dropTemporalCases.filter(c => c.platform === platform))("temporal: $ordering / $reply / $successors / $completion / $source → $target", async c => {
    hit = target(c);
    if (c.target === "plugin") cleanup.push(modules.targets.fileDropTargets.register(hit, (paths: readonly string[], kind: string) => {
      io.outcomes.push(`plugin:${kind}`); io.records.push({ paths: [...paths] });
    }));
    const entry = { path: sourcePath, name: "item", kind: "file" };
    if (c.ordering === "window-modal-during-native-start") {
      let rejectStart!: (reason: string) => void;
      io.start.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectStart = reject; }));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const redispatch = vi.fn((replay: Event) => {
        Object.defineProperty(replay, "target", { value: hit });
        return win.dispatchEvent(replay);
      });
      hit.dispatchEvent = redispatch;
      const effects: Promise<void>[] = [];
      win.addEventListener("drop", e => { effects.push(domDestination(e as DragEvent, c)); });
      const source = modules.html.createHtml5FileDrag();
      const dt = transfer();
      const start = event("dragstart", dt, c, sourceNode);
      source.start(start, { ...entry, kind: c.source.endsWith("-folder") ? "directory" : "file" }); sourceEnd = source.end;
      doc.dispatchEvent(start); sidebarOver = !!hit.closest(".quick-access");
      const drop = event("drop", dt, c); win.dispatchEvent(drop);
      expect(drop.stopped).toBe(true);
      expect(io.start).toHaveBeenCalledOnce();
      expect(io.outcomes).toEqual([]);
      cleanup.push(modules.ownership.modalOwnership.registerSurface(() => {}).release);
      expect(modules.dialogs.dialogStore.hasModalOpen).toBe(true);
      doc.dispatchEvent(event("dragend", transfer(), c, sourceNode));
      source.end(); rejectStart("unavailable"); await flush();
      await Promise.all(effects);
      expect(redispatch).not.toHaveBeenCalled();
      expect(io.outcomes).toEqual([]);
      expect(io.records).toEqual([]);
      expect(c.expected).toBe("blocked");
      return;
    } else if (c.ordering === "retained-local" || c.ordering === "late-start-reply") {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let resolveStart!: () => void, rejectStart!: (reason: string) => void;
      const decideStart = () => c.reply === "accepted" ? resolveStart() : rejectStart("unavailable");
      io.start.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; }))
        .mockRejectedValueOnce("unavailable");
      const old = modules.html.createHtml5FileDrag(() => {}, "move");
      old.start(event("dragstart", transfer(), c), { ...entry, path: "/old/item" });
      observationTime += 2; old.end();
      expect(modules.drag.dragState.current?.path).toBe("/old/item");
      observationTime += 2;
      const recent = peer.html.createHtml5FileDrag(() => {}, "link");
      recent.start(event("dragstart", transfer(), c), { ...entry, kind: "directory" }); sourceEnd = recent.end;
      await flush();
      native("enter", null, c);
      if (c.ordering === "late-start-reply") { decideStart(); await flush(); }
      native("drop", null, c); await flush();
      if (c.ordering === "retained-local") { decideStart(); await flush(); }
    } else {
      const sourceState = (c.window === "cross-window" ? peer : modules).drag.dragState;
      sourceState.start({ ...entry, html5: true, nativeCopyPolicy: "move" });
      const source = { ...sourceState.current };
      const lease = sourceState.beginNative(source);
      if (c.ordering === "same-millisecond-replacement") lease.failed();
      else if (c.completion !== "pending-reply") lease.acknowledge();
      const capturedAt = observationTime + (c.ordering === "same-millisecond-replacement" ? 2.25 : 0.25);
      if (c.ordering === "completion-backlog") {
        // Rust verifies that platform completion retires before this Enter.
        // Its renderer notification has deliberately not arrived yet.
        observationTime += 2;
        if (c.completion !== "pending-reply") sourceState.endHtml5(source);
        native("enter", null, c, undefined, source.gestureSequence); lease.complete(); lease.acknowledge();
        native("drop", null, c, undefined, source.gestureSequence);
      } else {
        observationTime += 2; sourceState.endHtml5(source);
        if (c.ordering === "same-millisecond-replacement") sourceState.finish(source);
        else lease.complete();
        if (c.ordering === "expired-provenance") {
          for (let i = 0; i < 8; i++) {
            observationTime += 2;
            modules.drag.dragState.start({ ...entry, html5: c.successors === "html5" });
            observationTime += 2; modules.drag.dragState.finish(modules.drag.dragState.current);
          }
        }
        if (c.ordering === "captured-before-replacement" || c.ordering === "same-millisecond-replacement") {
          if (c.ordering !== "same-millisecond-replacement") observationTime += 2;
          modules.drag.dragState.start({ ...entry, kind: "directory", html5: true, nativeCopyPolicy: "link" });
        }
        const provenance = c.ordering === "same-millisecond-replacement" ? null : source;
        native("enter", provenance, c, capturedAt); native("drop", provenance, c, capturedAt);
      }
      await flush();
    }
    await vi.waitFor(() => expect(io.outcomes.length || modules.toast.toastStore.toasts.some((toast: {message: string}) => /gesture identity expired/.test(toast.message))).toBeTruthy());
    const outcomes = io.outcomes.length ? io.outcomes : ["blocked"];
    expect(outcomes).toEqual([branchDropPolicy(c).outcome]);
    for (const record of io.records) {
      expect(record.paths).toEqual([sourcePath]);
      if (record.target) expect(record.target).toBe(destPath);
    }
  });
  it.each(outgoingFilesystemCases.filter(c => c.platform === platform))("drag-out URI export / $source / $transport", async c => {
    if (c.transport === "dom-only") delete (win as any).__TAURI_INTERNALS__;
    else { io.start.mockRejectedValue("unavailable"); vi.spyOn(console, "warn").mockImplementation(() => {}); }
    const dt = transfer();
    const source = modules.html.createHtml5FileDrag(() => {}, c.source === "recent" ? "link" : "modifier");
    source.start(event("dragstart", dt, c), { path: sourcePath, name: "item", kind: c.source.endsWith("-folder") || c.source === "recent" ? "directory" : "file" }); sourceEnd = source.end;
    await flush();
    expect(dt.effectAllowed).toBe(c.source === "recent" ? "link" : "all");
    const uri = dt.getData("text/uri-list");
    if (c.source === "recent") {
      expect(uri).not.toContain("file:"); expect(io.start).not.toHaveBeenCalled();
    } else {
      expect(uri).toBe("file://" + sourcePath);
      // WebKit's sanitizer parses the entire value as one URL. A session
      // comment fails this contract; filesystem drag-out must remain valid.
      expect(new URL(uri).protocol).toBe("file:");
      expect(uri).not.toContain(modules.drag.dragState.current.sessionId);
    }
    expect(dt.getData("text/html")).toContain(modules.drag.dragState.current.sessionId);
    expect(dt.getData("text/html")).not.toContain("href");
  });
  it.each(outgoingRecentCases.filter(c => c.platform === platform))("outgoing Recent / $adapter / $backend (native Link maps to $nativeLinkEffect)", async ({ adapter }) => {
    const dt = transfer();
    const c: DropCase = { platform, source: "recent", target: "bookmark", modifier: "none", transport: "dom-only" };
    if (adapter === "html5") {
      const source = modules.html.createHtml5FileDrag(() => {}, "link");
      source.start(event("dragstart", dt, c), { path: sourcePath, name: "item", kind: "directory" }); sourceEnd = source.end;
      expect(dt.getData("text/uri-list")).toBe(`urn:tauri-explorer:drag:${modules.drag.dragState.current.sessionId}`);
      expect(dt.getData("text/plain")).toBe("");
    } else if (adapter === "pointer") {
      hit = dropElement();
      const source = modules.sidebarPointer.useSidebarDrag();
      source.handlePointerDown({ button: 0, preventDefault() {}, clientX: 10, clientY: 10 } as MouseEvent, sourcePath, "item");
      win.dispatchEvent(Object.assign(new Event("mousemove"), { clientX: -10, clientY: 40 }));
      sourceEnd = () => win.dispatchEvent(new Event("blur"));
    } else {
      modules.drag.dragState.start({ path: sourcePath, name: "item", kind: "directory", nativeCopyPolicy: "link" });
      void modules.external.startExternalDrag([sourcePath]);
    }
    await flush();
    expect(modules.drag.dragState.current?.nativeCopyPolicy).toBe("link");
    expect(io.start).not.toHaveBeenCalled();
  });
});

it("every declared difference has exercised rows, and the Cartesian matrix is complete", () => {
  expect(dropCases).toHaveLength(3510);
  expect(dropVisibilityCases).toHaveLength(dropLateDomCases.length + 2 * (dropCases.length + dropDeliveryCases.length + dropRejectedDomCases.length
    + dropBoundaryCases.length + dropCrossWindowCases.length + dropPathCases.length));
  for (const c of dropCases) {
    const rows = dropVisibilityCases.filter(row => row.platform === c.platform && row.source === c.source
      && row.target === c.target && row.modifier === c.modifier && row.transport === c.transport
      && !row.deliveryOrder && !row.lifetime && !row.window && !row.pathPair);
    expect(rows.map(row => row.visibility)).toEqual([...dropVisibilities]);
  }
  expect(dropDeliveryCases).toHaveLength(2730);
  for (const platform of dropPlatforms) for (const target of dropTargets) for (const deliveryOrder of dropDeliveryOrders) {
    const rows = dropDeliveryCases.filter(c => c.platform === platform && c.target === target && c.deliveryOrder === deliveryOrder);
    expect(new Set(rows.map(c => c.source))).toEqual(new Set(dropSources));
    expect(rows).toHaveLength(dropSources.length * (deliveryOrder === "dom-only" ? 1 : 2));
  }
  for (const difference of intendedDifferences) expect(dropVisibilityCases.some(c => branchDropPolicy(c).difference === difference.id)).toBe(true);
  expect(dropCrossWindowCases.length).toBeGreaterThan(0); expect(dropPathCases).toHaveLength(66);
});
