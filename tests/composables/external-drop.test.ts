import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ listen: vi.fn(), deliver: null as ((event: any) => void) | null }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ listen: (_name: string, listener: (event: any) => void) => native.listen(listener) }) }));
import { dragClock } from "$lib/state/drag-clock";
import { useExternalDrop } from "$lib/composables/use-external-drop.svelte";

const event = (type: string) => ({ payload: { type, position: { x: 200, y: 300 }, paths: ["/a.png", "/b.png"], copyModifier: true, observedAt: 1011.25, observationClock: "process-clock", completedGestureSequence: 7 } });
beforeEach(() => { native.listen.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("native drop listener lifecycle", () => {
  it("passes native Enter paths through before hover, then lets claimed drop own cleanup", async () => {
    native.listen.mockImplementation(async (deliver: (event: any) => void) => { native.deliver = deliver; return vi.fn(); });
    const callbacks = { onEnter: vi.fn(), onOver: vi.fn(), onDrop: vi.fn(), onLeave: vi.fn() };
    const service = useExternalDrop(callbacks); await service.setup();
    native.deliver!(event("enter"));
    expect(callbacks.onEnter).toHaveBeenCalledWith(["/a.png", "/b.png"], { x: 200, y: 300 }, undefined, true, 1011.25, 7, "process-clock");
    expect(callbacks.onOver).toHaveBeenCalledWith({ x: 200, y: 300 }, true);
    expect(service.state.isDragging).toBe(true);
    native.deliver!(event("drop"));
    expect(callbacks.onDrop).toHaveBeenCalledExactlyOnceWith(["/a.png", "/b.png"], { x: 200, y: 300 }, undefined, true, 1011.25, 7, "process-clock");
    expect(callbacks.onLeave).not.toHaveBeenCalled(); expect(service.state.isDragging).toBe(false);
    service.cleanup();
  });

  it("unlistens a registration resolving after cleanup and ignores its late events", async () => {
    let finish!: (unlisten: () => void) => void;
    native.listen.mockImplementation((deliver: (event: any) => void) => { native.deliver = deliver; return new Promise(resolve => { finish = resolve; }); });
    const callbacks = { onDrop: vi.fn(), onLeave: vi.fn() }; const unlisten = vi.fn();
    const service = useExternalDrop(callbacks); const pending = service.setup();
    await vi.waitFor(() => expect(native.listen).toHaveBeenCalledOnce());
    service.cleanup();
    native.deliver!(event("drop")); finish(unlisten); await pending;
    expect(unlisten).toHaveBeenCalledOnce(); expect(callbacks.onDrop).not.toHaveBeenCalled();
  });

  it("isolates a replacement subscription from a late earlier registration", async () => {
    const deliveries: ((event: any) => void)[] = []; const finishes: ((unlisten: () => void) => void)[] = [];
    native.listen.mockImplementation((deliver: (event: any) => void) => { deliveries.push(deliver); return new Promise(resolve => { finishes.push(resolve); }); });
    const onDrop = vi.fn(); const service = useExternalDrop({ onDrop });
    const old = service.setup();
    await vi.waitFor(() => expect(native.listen).toHaveBeenCalledOnce());
    const current = service.setup();
    await vi.waitFor(() => expect(native.listen).toHaveBeenCalledTimes(2));
    const oldUnlisten = vi.fn(); const currentUnlisten = vi.fn();
    finishes[1](currentUnlisten); await current; finishes[0](oldUnlisten); await old;
    deliveries[0](event("drop")); deliveries[1](event("drop"));
    expect(onDrop).toHaveBeenCalledOnce(); expect(oldUnlisten).toHaveBeenCalledOnce(); expect(currentUnlisten).not.toHaveBeenCalled();
    service.cleanup(); expect(currentUnlisten).toHaveBeenCalledOnce();
  });
});


it("a retired native listener cannot install after its monotonic calibration resolves", async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  let calibrated!: () => void;
  vi.spyOn(dragClock, "initialize").mockImplementation(() => new Promise(resolve => { calibrated = resolve; }));
  const service = useExternalDrop({ onDrop: vi.fn() });
  const setup = service.setup();
  expect(native.listen).not.toHaveBeenCalled();
  service.cleanup(); calibrated(); await setup;
  expect(native.listen).not.toHaveBeenCalled();
});
