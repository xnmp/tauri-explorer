import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredFocusRequest } from "$lib/state/deferred-focus";
import { TerminalPanelStore } from "$lib/state/terminal.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";

afterEach(() => { dialogStore.closeAll(); vi.unstubAllGlobals(); });

describe("deferred focus ownership", () => {
  it("accepts unchanged focus once", () => {
    const request = createDeferredFocusRequest(new EventTarget(), () => true);
    expect(request.consume()).toBe(true);
    expect(request.consume()).toBe(false);
  });

  for (const event of ["keydown", "pointerdown", "blur"]) {
    it(`retires permanently after ${event}`, () => {
      const events = new EventTarget();
      const request = createDeferredFocusRequest(events, () => true);
      events.dispatchEvent(new Event(event));
      expect(request.consume()).toBe(false);
    });
  }

  it("checks current eligibility at consumption, without reviving a rejected request", () => {
    let current = true;
    const request = createDeferredFocusRequest(new EventTarget(), () => current);
    current = false;
    expect(request.consume()).toBe(false);
    current = true;
    expect(request.consume()).toBe(false);
  });

  it("cancellation is permanent and idempotent", () => {
    const request = createDeferredFocusRequest(new EventTarget(), () => true);
    request.cancel();
    request.cancel();
    expect(request.consume()).toBe(false);
  });
});

describe("terminal opening focus", () => {
  function fixture() {
    const events = new EventTarget();
    const store = new TerminalPanelStore(() => createDeferredFocusRequest(events, () => true));
    return { store, events };
  }

  it("gives a programmatically opened modal priority over a pending terminal", () => {
    vi.stubGlobal("window", new EventTarget());
    const store = new TerminalPanelStore();
    store.open();
    dialogStore.openQuickOpen();
    expect(store.consumeFocus()).toBe(false);
    dialogStore.closeAll();
    expect(store.consumeFocus()).toBe(false);
  });

  it("preserves a newer interaction while a cold panel mounts", () => {
    const { store, events } = fixture();
    store.open();
    events.dispatchEvent(new Event("pointerdown"));
    expect(store.visible).toBe(true);
    expect(store.consumeFocus()).toBe(false);
    store.close();
    store.open();
    expect(store.consumeFocus()).toBe(true);
  });

  it("close cancels an unmounted panel's focus request", () => {
    const { store } = fixture();
    store.open();
    store.close();
    expect(store.consumeFocus()).toBe(false);
  });

  it("queued paths still arrive after focus ownership moves elsewhere", () => {
    const { store, events } = fixture();
    store.insertPaths(["/first"]);
    events.dispatchEvent(new Event("keydown"));
    const insert = vi.fn();
    const unregister = store.registerPathsSink(insert);
    expect(insert.mock.calls).toEqual([[["/first"]]]);
    expect(store.consumeFocus()).toBe(false);
    store.insertPaths(["/second"]);
    expect(insert.mock.calls).toEqual([[["/first"]], [["/second"]]]);
    expect(store.consumeFocus()).toBe(true);
    unregister();
  });

  it("unmount cancels focus and detaches the insertion consumer", () => {
    const { store } = fixture();
    const insert = vi.fn();
    const unregister = store.registerPathsSink(insert);
    store.open();
    unregister();
    expect(store.consumeFocus()).toBe(false);
    store.insertPaths(["/next"]);
    expect(insert).not.toHaveBeenCalled();
    store.close();
  });
});
