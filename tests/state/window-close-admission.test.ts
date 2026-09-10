import { expect, it, vi } from "vitest";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("titlebar close immediately blocks new ownership until native retirement", async () => {
  const retirement = deferred<void>();
  const native = { close: () => retirement.promise, destroy: () => retirement.promise, onCloseRequested: async () => () => {} };
  const manager = createWindowTabsManager({ nativeWindow: () => native });
  try {
    manager.init("/home/user");
    const snapshot = manager.exportTab(manager.activeTabId!)!;
    const before = manager.captureState();
    const closing = manager.requestWindowClose();
    expect(() => manager.createTab("/home/user/Documents")).toThrow("Window is closing");
    expect(() => manager.adoptTab(snapshot)).toThrow("Window is closing");
    expect(() => manager.restoreFromState(before)).toThrow("Window is closing");
    expect(manager.beginTabTransfer(manager.activeTabId!)).toBeNull();
    expect(manager.captureState()).toEqual(before);
    retirement.resolve();
    expect(await closing).toBe(true);
  } finally { retirement.resolve(); await manager.dispose(); }
});

it("a native close request blocks admission and explicitly owns terminal destruction", async () => {
  const retirement = deferred<void>();
  let request!: (event: { preventDefault(): void }) => void;
  const native = {
    close: vi.fn(async () => {}), destroy: vi.fn(() => retirement.promise),
    onCloseRequested: async (handler: typeof request) => { request = handler; return () => {}; },
  };
  const manager = createWindowTabsManager({ nativeWindow: () => native });
  try {
    manager.init("/home/user");
    const stop = manager.observeNativeClose();
    await Promise.resolve();
    expect(request).toBeTypeOf("function");
    const event = { preventDefault: vi.fn() };
    request(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(() => manager.createTab("/tmp")).toThrow("Window is closing");
    await vi.waitFor(() => expect(native.destroy).toHaveBeenCalledOnce());
    expect(native.close).not.toHaveBeenCalled();
    retirement.resolve();
    stop();
  } finally { retirement.resolve(); await manager.dispose(); }
});
