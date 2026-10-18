/**
 * Spring-load gesture identity at the drop handler (#1269 review): a native
 * Drop that outlives the lost-Leave fallback must land where the drag was, not
 * where the layout moved to once the temporary peeks closed; a replayed DOM
 * drop must only end the springs and feedback of its own drag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/state/drag-clock", async actual => ({ ...await actual<object>(), dragClock: {
  initialize: async () => {}, ready: true,
  stamp: () => ({ clockId: `browser:${performance.timeOrigin}`, at: Math.floor(performance.timeOrigin + performance.now()), uncertainty: 0 }),
} }));
const spring = vi.hoisted(() => ({
  calls: [] as string[], gesture: "g1", settled: 0, revision: 0,
}));
vi.mock("$lib/composables/spring-load", () => ({
  springHover: (locate: () => Element | null) => { spring.calls.push(`hover:${(locate() as unknown as { id?: string } | null)?.id ?? "null"}`); },
  springEnd: (gesture?: string) => { spring.calls.push(gesture === undefined ? "end" : `end:${gesture}`); },
  springEndSoon: () => { spring.calls.push("endSoon"); },
  springRevision: () => spring.revision,
  springSettle: () => { spring.settled++; },
  springGesture: () => spring.gesture,
  springHold: () => { spring.calls.push("hold"); return () => { spring.calls.push("release"); }; },
}));
const native = vi.hoisted(() => ({ emit: undefined as ((event: unknown) => void) | undefined }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({
  listen: (_name: string, listener: (event: unknown) => void) => { native.emit = listener; return Promise.resolve(() => {}); },
}) }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<object>(), invoke: () => Promise.resolve(undefined) }));
const { panes, drops, toasts } = vi.hoisted(() => ({ panes: new Map<string, unknown>(), drops: vi.fn(), toasts: vi.fn() }));
vi.mock("$lib/state/drop-operations", async importOriginal => ({ ...await importOriginal<object>(), handleFileDropMany: drops }));
vi.mock("$lib/state/toast.svelte", async importOriginal => {
  const actual = await importOriginal<{ toastStore: object }>();
  return { ...actual, toastStore: { ...actual.toastStore, show: toasts } };
});
vi.mock("$lib/composables/use-dom-directory-drop", () => ({ dropIntoDirectory: vi.fn() }));
vi.mock("$lib/state/window-tabs.svelte", () => ({
  windowTabsManager: { getExplorer: (id: string) => panes.get(id), tabs: [], getTabPath: () => null, activePaneId: "p1" },
}));

import { useNativeDropHandler } from "$lib/composables/use-native-drop-handler";
import { useBackgroundDropFeedback } from "$lib/composables/use-drop-target.svelte";
import { dropIntoDirectory } from "$lib/composables/use-dom-directory-drop";
import { dragState } from "$lib/state/drag.svelte";
import { createHtml5FileDrag } from "$lib/state/html5-file-drag.svelte";
import { dropElement } from "../helpers/drop-element";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let win: EventTarget;
let under: HTMLElement;
let cleanup: (() => void) | null = null;

class FakeTransfer {
  data = new Map<string, string>();
  effectAllowed = "all";
  dropEffect = "none";
  get types() { return [...this.data.keys()]; }
  setData(type: string, value: string) { this.data.set(type, value); }
  getData(type: string) { return this.data.get(type) ?? ""; }
}
class FakeDragEvent extends Event {
  dataTransfer: unknown; clientX: number; clientY: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; relatedTarget = null;
  constructor(type: string, init: Record<string, unknown> = {}) {
    super(type, init as EventInit);
    this.dataTransfer = init.dataTransfer; this.clientX = (init.clientX as number) ?? 0; this.clientY = (init.clientY as number) ?? 0;
    this.ctrlKey = !!init.ctrlKey; this.altKey = !!init.altKey; this.shiftKey = !!init.shiftKey; this.metaKey = !!init.metaKey;
  }
}
/** The temporary peeks changed (the fallback, a newer drag's end, a Leave). */
const closePeeks = () => { spring.revision++; };
const named = (id: string, className = "entry-item directory") => Object.assign(dropElement(className, { "data-path": `/r/${id}` }), { id });
const nativeEvent = (type: string, extra: object = {}) =>
  native.emit!({ payload: { type, paths: ["/outside/a.txt"], position: { x: 40, y: 60 }, externalSource: true, ...extra } });
const domEvent = (type: string, target: unknown, dataTransfer: unknown = new FakeTransfer()) => {
  const event = new FakeDragEvent(type, { dataTransfer, bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { value: target });
  return event;
};

beforeEach(async () => {
  spring.calls.length = 0; spring.gesture = "g1"; spring.settled = 0; spring.revision = 0;
  drops.mockClear(); toasts.mockClear(); panes.clear();
  dragState.clear();
  win = new EventTarget();
  under = named("row-a");
  vi.stubGlobal("window", Object.assign(win, { __TAURI_INTERNALS__: {}, devicePixelRatio: 1 }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { elementFromPoint: () => under, documentElement: { style: { zoom: "100%" } } }));
  vi.stubGlobal("DataTransfer", FakeTransfer);
  vi.stubGlobal("DragEvent", FakeDragEvent);
  const service = useNativeDropHandler({
    getActiveExplorer: () => ({ currentPath: "/r", captureMutation: () => ({ current: () => true }) }) as never,
    refreshAllPanes: vi.fn(),
  });
  service.setup();
  cleanup = service.cleanup;
  await flush();
});
afterEach(() => {
  cleanup?.(); cleanup = null;
  dragState.clear();
  vi.unstubAllGlobals();
});

describe("a native Drop after the lost-Leave fallback closed the peeks", () => {
  /** The receiver reports the drag over row-a; the source's dragend defers to the fallback. */
  function hoverThenDragEnd() {
    nativeEvent("enter");
    nativeEvent("over");
    win.dispatchEvent(domEvent("dragend", under));
    expect(spring.calls.at(-1)).toBe("endSoon");
  }

  it("goes to the folder the drag was over, not the one that moved under the pointer", async () => {
    hoverThenDragEnd();
    // The fallback fires, the peeks close and another folder's row slides under the pointer.
    closePeeks();
    under = named("row-b");
    nativeEvent("drop");
    await flush();
    expect(drops).toHaveBeenCalledTimes(1);
    expect(drops.mock.calls[0][0]).toEqual(["/outside/a.txt"]);
    expect(drops.mock.calls[0][1]).toBe("/r/row-a");
  });

  it("before the fallback fires the position stays the authority", async () => {
    hoverThenDragEnd();
    under = named("row-b");
    nativeEvent("drop");
    await flush();
    expect(drops.mock.calls[0][1]).toBe("/r/row-b");
  });

  it("with no captured target it cancels with a toast instead of guessing", async () => {
    nativeEvent("enter");
    nativeEvent("over");
    under = null as never; // nothing under the pointer: no target to capture
    win.dispatchEvent(domEvent("dragend", under));
    closePeeks();
    nativeEvent("drop");
    await flush();
    expect(drops).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledTimes(1);
  });

  it("a later gesture does not inherit the captured target", async () => {
    hoverThenDragEnd();
    closePeeks();
    nativeEvent("leave");
    nativeEvent("enter");
    nativeEvent("over");
    under = named("row-c");
    nativeEvent("drop");
    await flush();
    expect(drops.mock.calls[0][1]).toBe("/r/row-c");
  });
});

describe("two drags in a row (the first one's Drop is still owed)", () => {
  // Sessions are claimed once per module: every test gets its own.
  let n = 0;
  let S1 = "s1", S2 = "s2";
  beforeEach(() => { n++; S1 = `s1-${n}`; S2 = `s2-${n}`; });
  const source = (sessionId: string) => ({ path: "/r/f.txt", name: "f.txt", kind: "file", sessionId });
  const internal = (session: string) => ({ source: source(session), externalSource: false, paths: ["/r/f.txt"] });
  const dragEnd = (session: string) => {
    const transfer = new FakeTransfer();
    transfer.setData("application/x-explorer-session", session);
    win.dispatchEvent(domEvent("dragend", under, transfer));
  };
  /** Drag 1 hovers row-a (its peek open) and ends; drag 2 starts and its first hover closes drag 1's peeks. */
  function secondDragStarts() {
    nativeEvent("enter", internal(S1));
    nativeEvent("over", internal(S1));
    dragEnd(S1);
    expect(spring.calls.at(-1)).toBe("endSoon");
    win.dispatchEvent(domEvent("dragstart", under));
    nativeEvent("enter", internal(S2));
    closePeeks(); // drag 2's first hover ends drag 1's gesture
    under = named("row-b"); // the layout shifted under the pointer
  }

  it("drag 1's Drop still goes to the folder it was over, 300ms after the second drag started", async () => {
    secondDragStarts();
    nativeEvent("drop", internal(S1));
    await flush();
    expect(drops).toHaveBeenCalledTimes(1);
    expect(drops.mock.calls[0][1]).toBe("/r/row-a");
  });

  it("and 650ms after, when the fallback has fired as well", async () => {
    secondDragStarts();
    closePeeks();
    nativeEvent("drop", internal(S1));
    await flush();
    expect(drops.mock.calls[0][1]).toBe("/r/row-a");
  });

  it("drag 2's own Drop never uses drag 1's capture", async () => {
    secondDragStarts();
    nativeEvent("over", internal(S2));
    nativeEvent("drop", internal(S2));
    await flush();
    expect(drops.mock.calls[0][1]).toBe("/r/row-b");
  });

  it("captures are bounded: an old drag whose Drop never came is eventually forgotten", async () => {
    nativeEvent("enter", internal(S1));
    nativeEvent("over", internal(S1));
    dragEnd(S1);
    // Drag 2 ends the same way, ten drags later: the map stays bounded.
    for (let i = 0; i < 20; i++) {
      nativeEvent("enter", internal(`x${i}`));
      nativeEvent("over", internal(`x${i}`));
      dragEnd(`x${i}`);
    }
    closePeeks();
    under = named("row-b");
    nativeEvent("enter", internal(S1));
    nativeEvent("over", internal(S1));
    nativeEvent("drop", internal(S1));
    await flush();
    // The oldest capture was evicted: s1 resolves live.
    expect(drops.mock.calls[0][1]).toBe("/r/row-b");
  });

  it("cancelling for an unknown destination settles the dragged source like a completed drop", async () => {
    const claim = vi.spyOn(dragState, "claim");
    nativeEvent("enter", internal(S1));
    nativeEvent("over", internal(S1));
    under = null as never;
    dragEnd(S1);
    closePeeks();
    nativeEvent("drop", internal(S1));
    await flush();
    expect(drops).not.toHaveBeenCalled();
    expect(toasts).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ sessionId: S1 }));
  });
});

describe("the lost-Leave fallback's cancels", () => {
  function deferred() {
    nativeEvent("enter");
    nativeEvent("over");
    win.dispatchEvent(domEvent("dragend", under));
    spring.settled = 0; spring.calls.length = 0;
  }

  it("the native Drop ends the peeks itself, which is what cancels the fallback", async () => {
    deferred();
    nativeEvent("drop");
    await flush();
    expect(spring.calls[0]).toBe("end");
  });

  it("a new DOM drag, a native Enter and a native Leave settle it", () => {
    deferred();
    win.dispatchEvent(domEvent("dragstart", under));
    expect(spring.settled).toBe(1);
    nativeEvent("enter");
    expect(spring.settled).toBe(2);
    nativeEvent("leave");
    expect(spring.settled).toBe(3);
  });
});

describe("a replayed DOM drop", () => {
  /** A pending native start for drag 1; returns what rejects it. */
  function pendingDrop(target: HTMLElement) {
    const transfer = new FakeTransfer();
    createHtml5FileDrag().start(new FakeDragEvent("dragstart", { dataTransfer: transfer }) as unknown as DragEvent, { path: "/r/f.txt", name: "f.txt", kind: "file" });
    const lease = dragState.beginNative(dragState.current);
    Object.assign(target, { dispatchEvent: (event: Event) => { Object.defineProperty(event, "target", { value: target }); return win.dispatchEvent(event); } });
    win.dispatchEvent(domEvent("drop", target, transfer));
    return lease;
  }

  it("plain dispatch ends only its own drag's springs and feedback", async () => {
    const lease = pendingDrop(named("row-a"));
    expect(spring.calls).toEqual(["hold"]);
    // A newer drag starts, springs a peek and highlights the listing background.
    spring.gesture = "g2";
    const background = useBackgroundDropFeedback();
    background.set(true);
    lease.failed();
    await flush();
    expect(spring.calls).toContain("release");
    expect(spring.calls.filter(call => call.startsWith("end"))).not.toContain("end");
    expect(spring.calls.filter(call => call === "end:g2")).toEqual([]);
    expect(background.active).toBe(true);
  });

  it("plain dispatch of the still-current drag ends its springs, scoped to it", async () => {
    const lease = pendingDrop(named("row-a"));
    lease.failed();
    await flush();
    expect(spring.calls).toContain("end:g1");
    expect(spring.calls).not.toContain("end");
  });

  it("a replay into a temporary peek's folder ends only the springs of its drag", async () => {
    const listing = dropElement("explorer-pane", { "data-pane-id": "p1" });
    const content = dropElement("content", { "data-current-path": "/r" }, dropElement("file-list", {}, listing));
    const row = dropElement("entry-item file-item", { "data-path": "/r/Inbox/a.txt" }, content);
    panes.set("p1", {
      springPeeks: ["/r/Inbox"], isSpringPeek: (path: string) => path === "/r/Inbox",
      springDropFolder: () => "/r/Inbox", captureMutation: () => ({ current: () => true }),
    });
    const lease = pendingDrop(row);
    spring.gesture = "g2";
    lease.failed();
    await flush();
    expect(dropIntoDirectory).toHaveBeenCalledTimes(1);
    expect(spring.calls).toContain("end:g1");
    expect(spring.calls).not.toContain("end");
  });
});
