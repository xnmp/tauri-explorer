/**
 * Spring-loaded peeks (#1242) under a Linux native drag: the native receiver
 * and the webview's DOM drag events report the same gesture, and can disagree
 * by a fraction of a pixel at a row's edge. While the receiver reports the
 * drag, its position is the one hover authority (the native Drop resolves its
 * target from it); a DOM-only drag keeps driving hover through DOM events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/state/drag-clock", async actual => ({ ...await actual<object>(), dragClock: {
  initialize: async () => {}, ready: true,
  stamp: () => ({ clockId: `browser:${performance.timeOrigin}`, at: Math.floor(performance.timeOrigin + performance.now()), uncertainty: 0 }),
} }));
const spring = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("$lib/composables/spring-load", () => ({
  springHover: (locate: () => Element | null) => { spring.calls.push(`hover:${(locate() as unknown as { id?: string } | null)?.id ?? "null"}`); },
  springEnd: () => { spring.calls.push("end"); },
  springHold: () => () => {},
}));
const native = vi.hoisted(() => ({ emit: undefined as ((event: unknown) => void) | undefined }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({
  listen: (_name: string, listener: (event: unknown) => void) => { native.emit = listener; return Promise.resolve(() => {}); },
}) }));
vi.mock("@tauri-apps/api/core", async importOriginal => ({ ...await importOriginal<object>(), invoke: () => Promise.resolve(undefined) }));
vi.mock("$lib/state/drop-operations", async importOriginal => ({ ...await importOriginal<object>(), handleFileDropMany: vi.fn().mockResolvedValue(undefined) }));

import { useNativeDropHandler } from "$lib/composables/use-native-drop-handler";
import { dragState } from "$lib/state/drag.svelte";
import { dropElement } from "../helpers/drop-element";

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
let win: EventTarget;
let atNative: HTMLElement;
let cleanup: (() => void) | null = null;

function files(): DataTransfer {
  return { types: ["Files"], files: [], items: [], getData: () => "", setData: () => {}, dropEffect: "none", effectAllowed: "all" } as unknown as DataTransfer;
}
function domEvent(type: string, target: HTMLElement): DragEvent {
  const event = Object.assign(new Event(type, { cancelable: true }), { dataTransfer: files(), clientX: 20, clientY: 30, ctrlKey: false, altKey: false, relatedTarget: null });
  Object.defineProperty(event, "target", { value: target });
  return event as unknown as DragEvent;
}
const nativeEvent = (type: string) => native.emit!({ payload: { type, paths: ["/outside/a.txt"], position: { x: 40, y: 60 }, externalSource: true } });
const named = (id: string, className = "entry-item directory") => Object.assign(dropElement(className, { "data-path": `/r/${id}` }), { id });

beforeEach(async () => {
  spring.calls.length = 0;
  dragState.clear();
  win = new EventTarget();
  atNative = named("native-row");
  vi.stubGlobal("window", Object.assign(win, { __TAURI_INTERNALS__: {}, devicePixelRatio: 1 }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { elementFromPoint: () => atNative, documentElement: { style: { zoom: "100%" } } }));
  const service = useNativeDropHandler({ getActiveExplorer: () => ({ currentPath: "/r", captureMutation: () => ({ current: () => true }) }) as never, refreshAllPanes: vi.fn() });
  service.setup();
  cleanup = service.cleanup;
  await flush();
});
afterEach(() => {
  cleanup?.();
  cleanup = null;
  dragState.clear();
  vi.unstubAllGlobals();
});

describe("spring hover authority", () => {
  it("while the native receiver reports the drag, DOM drag events never move the spring hover", () => {
    nativeEvent("enter");
    nativeEvent("over");
    expect(spring.calls.filter(call => call.startsWith("hover:"))).toEqual(["hover:native-row", "hover:native-row"]);
    spring.calls.length = 0;
    const domRow = named("dom-row");
    win.dispatchEvent(domEvent("dragenter", domRow));
    win.dispatchEvent(domEvent("dragover", domRow));
    expect(spring.calls).toEqual([]);
    // Leaving through the receiver closes the spring.
    nativeEvent("leave");
    expect(spring.calls).toEqual(["hover:null"]);
  });

  it("a DOM-only drag (no native report) drives the spring hover from its events", () => {
    const domRow = named("dom-row");
    win.dispatchEvent(domEvent("dragenter", domRow));
    win.dispatchEvent(domEvent("dragover", domRow));
    expect(spring.calls).toEqual(["hover:dom-row", "hover:dom-row"]);
  });

  it("once the native receiver leaves, DOM events drive the hover again", () => {
    nativeEvent("enter");
    nativeEvent("leave");
    spring.calls.length = 0;
    win.dispatchEvent(domEvent("dragover", named("dom-row")));
    expect(spring.calls).toEqual(["hover:dom-row"]);
  });

  it("a native Leave lost before the next drag starts leaves that drag's DOM events in charge of the hover and its end", () => {
    nativeEvent("enter");
    nativeEvent("over");
    // The receiver's Leave never arrives; a new drag session starts in the webview.
    spring.calls.length = 0;
    win.dispatchEvent(domEvent("dragstart", named("source", "entry-item")));
    const domRow = named("dom-row");
    win.dispatchEvent(domEvent("dragenter", domRow));
    win.dispatchEvent(domEvent("dragover", domRow));
    expect(spring.calls).toEqual(["hover:dom-row", "hover:dom-row"]);
    // Cancelled, its dragend closes the temporary peeks.
    win.dispatchEvent(domEvent("dragend", domRow));
    expect(spring.calls.at(-1)).toBe("end");
  });
});
