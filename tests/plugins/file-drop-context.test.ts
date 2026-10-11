import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginContext } from "$lib/plugins/api";
import { fileDropTargets } from "$lib/state/file-drop-targets.svelte";
import { dispatchFileDrop } from "$lib/state/dispatch-file-drop";
import { toastStore } from "$lib/state/toast.svelte";
import { dropElement } from "../helpers/drop-element";

vi.mock("$lib/api/crash", () => ({ logFrontendError: vi.fn().mockResolvedValue(undefined) }));
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); toastStore.clear(); vi.restoreAllMocks(); });
function context() { const value = createPluginContext("drop-test", "Drop Test"); disposers.push(value.dispose); return value; }

describe("plugin file drop context lifecycle", () => {
  it("releases completed target teardowns instead of replaying them at plugin disposal", () => {
    const register = fileDropTargets.register.bind(fileDropTargets);
    const teardowns: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(fileDropTargets, "register").mockImplementation((...args) => {
      const unregister = vi.fn(register(...args)); teardowns.push(unregister); return unregister;
    });
    const { ctx, dispose } = context();
    for (let i = 0; i < 100; i++) ctx.workspace.registerFileDropTarget!(dropElement(), vi.fn())();
    const remaining = dropElement(); ctx.workspace.registerFileDropTarget!(remaining, vi.fn());
    expect(teardowns.slice(0, 100).every(unregister => unregister.mock.calls.length === 1)).toBe(true);
    expect(fileDropTargets.resolve(remaining)?.type).toBe("plugin");
    dispose(); expect(fileDropTargets.resolve(remaining)).toBeNull();
    expect(teardowns.every(unregister => unregister.mock.calls.length === 1)).toBe(true);
  });
  it("provides an idempotent disposer and automatically retires remaining registrations", () => {
    const { ctx, dispose } = context(); const first = dropElement(); const second = dropElement();
    const unregister = ctx.workspace.registerFileDropTarget!(first, vi.fn());
    ctx.workspace.registerFileDropTarget!(second, vi.fn());
    expect(fileDropTargets.resolve(first)?.type).toBe("plugin");
    unregister(); unregister(); expect(fileDropTargets.resolve(first)).toBeNull();
    dispose(); dispose(); expect(fileDropTargets.resolve(second)).toBeNull();
    ctx.workspace.registerFileDropTarget!(second, vi.fn()); expect(fileDropTargets.resolve(second)).toBeNull();
  });

  it("reports handler failure through plugin errors and consumes the claimed drop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = context(); const target = dropElement();
    ctx.workspace.registerFileDropTarget!(target, () => { throw new Error("inspection failed"); });
    const delivery = dispatchFileDrop(fileDropTargets.resolve(target), ["/a.png"], "external", null);
    expect(delivery).not.toBeNull(); await expect(delivery!).resolves.toBeUndefined();
    expect(toastStore.toasts.map(toast => toast.message)).toContain("Drop Test: inspection failed");
  });

  it("reports a failing enabled predicate and blocks instead of falling through", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = context(); const target = dropElement();
    ctx.workspace.registerFileDropTarget!(target, vi.fn(), { enabled: () => { throw new Error("bad predicate"); } });
    expect(fileDropTargets.resolve(target)).toEqual({ type: "blocked" });
    expect(toastStore.toasts.map(toast => toast.message)).toContain("Drop Test: bad predicate");
  });

  it("does not invoke a registration retired after resolution", async () => {
    const { ctx, dispose } = context(); const element = dropElement(); const handler = vi.fn();
    ctx.workspace.registerFileDropTarget!(element, handler); const target = fileDropTargets.resolve(element);
    dispose(); await dispatchFileDrop(target, ["/a.png"], "external", null);
    expect(handler).not.toHaveBeenCalled();
  });
});
