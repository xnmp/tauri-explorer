import { afterEach, describe, expect, it, vi } from "vitest";
import { createLazyDialog } from "$lib/state/lazy-dialog.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function fixture() {
  let open = true;
  const module = deferred<{ default: object }>();
  const notify = vi.fn();
  const rollback = vi.fn(() => { open = false; });
  const load = vi.fn(() => module.promise);
  const dialog = createLazyDialog({ label: "Settings", isOpen: () => open, load, onFailure: rollback }, notify);
  return { dialog, module, load, rollback, notify, setOpen: (value: boolean) => { open = value; } };
}

afterEach(() => vi.restoreAllMocks());

describe("owned lazy dialog", () => {
  it("shares a pending import through close/reopen and retains the constructor", async () => {
    const f = fixture();
    const first = f.dialog.load();
    f.setOpen(false);
    const second = f.dialog.load();
    f.setOpen(true);
    const component = {};
    f.module.resolve({ default: component });
    await Promise.all([first, second]);
    expect(f.dialog.component).toBe(component);
    await f.dialog.load();
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("rolls back and reports one failure for a shared import", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    const loads = [f.dialog.load(), f.dialog.load(), f.dialog.load()];
    f.module.reject(new Error("offline"));
    await Promise.all(loads);
    expect(f.rollback).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Settings"));
    expect(f.dialog.component).toBeNull();
  });

  it("does not roll back or notify a cancelled request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    const pending = f.dialog.load();
    f.setOpen(false);
    f.module.reject(new Error("offline"));
    await pending;
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("can retry a rejected import on a later open", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    f.load.mockRejectedValueOnce(new Error("offline"));
    await f.dialog.load();
    f.setOpen(true);
    const component = {};
    f.module.resolve({ default: component });
    await f.dialog.load();
    expect(f.dialog.component).toBe(component);
    expect(f.notify).toHaveBeenCalledOnce();
  });

  it.each(["resolve", "reject"] as const)("retires a late %s when the host is disposed", async (outcome) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    const pending = f.dialog.load();
    await Promise.resolve(); // The real importer has started.
    f.dialog.dispose();
    if (outcome === "resolve") f.module.resolve({ default: {} });
    else f.module.reject(new Error("offline"));
    await pending;
    await f.dialog.load();
    expect(f.dialog.component).toBeNull();
    expect(f.load).toHaveBeenCalledOnce();
    expect(f.rollback).not.toHaveBeenCalled();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("disposal before dispatch prevents the import from starting", async () => {
    const f = fixture();
    const pending = f.dialog.load();
    f.dialog.dispose();
    await pending;
    expect(f.load).not.toHaveBeenCalled();
  });

  it("contains synchronous import, rollback, and notification failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    f.load.mockImplementation(() => { throw new Error("import"); });
    f.rollback.mockImplementation(() => { throw new Error("rollback"); });
    f.notify.mockImplementation(() => { throw new Error("notify"); });
    await expect(f.dialog.load()).resolves.toBeUndefined();
    expect(f.notify).toHaveBeenCalledOnce();
  });
});
