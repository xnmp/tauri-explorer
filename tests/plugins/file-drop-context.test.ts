import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginContext } from "$lib/plugins/api";
import { fileDropTargets } from "$lib/state/file-drop-targets.svelte";
import { dispatchFileDrop } from "$lib/state/dispatch-file-drop";
import { toastStore } from "$lib/state/toast.svelte";
import type { Component } from "svelte";
import { fileViewRegistry } from "$lib/plugins/file-view-registry.svelte";
import { pluginDomOwnership } from "$lib/state/plugin-dom-ownership";
import { dropElement } from "../helpers/drop-element";

vi.mock("$lib/api/crash", () => ({ logFrontendError: vi.fn().mockResolvedValue(undefined) }));
const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); toastStore.clear(); vi.restoreAllMocks(); });
function context() {
  const value = createPluginContext("drop-test", "Drop Test"); disposers.push(value.dispose);
  value.ctx.registerFileView!({ id: "drop-test", title: "Drop Test", component: (() => {}) as unknown as Component, available: () => true });
  const component = fileViewRegistry.get("drop-test")!.component;
  const element = () => {
    const root = dropElement();
    disposers.push(pluginDomOwnership.mount(root, component).destroy);
    return dropElement("", {}, root);
  };
  return { ...value, element };
}

describe("plugin file drop context lifecycle", () => {
  it("releases completed target teardowns instead of replaying them at plugin disposal", () => {
    const register = fileDropTargets.register.bind(fileDropTargets);
    const teardowns: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(fileDropTargets, "register").mockImplementation((...args) => {
      const unregister = vi.fn(register(...args)); teardowns.push(unregister); return unregister;
    });
    const { ctx, dispose, element } = context();
    for (let i = 0; i < 100; i++) ctx.workspace.registerFileDropTarget!(element(), vi.fn())();
    const remaining = element(); ctx.workspace.registerFileDropTarget!(remaining, vi.fn());
    expect(teardowns.slice(0, 100).every(unregister => unregister.mock.calls.length === 1)).toBe(true);
    expect(fileDropTargets.resolve(remaining)?.type).toBe("plugin");
    dispose(); expect(fileDropTargets.resolve(remaining)).toBeNull();
    expect(teardowns.every(unregister => unregister.mock.calls.length === 1)).toBe(true);
  });
  it("provides an idempotent disposer and automatically retires remaining registrations", () => {
    const { ctx, dispose, element } = context(); const first = element(); const second = element();
    const unregister = ctx.workspace.registerFileDropTarget!(first, vi.fn());
    ctx.workspace.registerFileDropTarget!(second, vi.fn());
    expect(fileDropTargets.resolve(first)?.type).toBe("plugin");
    unregister(); unregister(); expect(fileDropTargets.resolve(first)).toBeNull();
    dispose(); dispose(); expect(fileDropTargets.resolve(second)).toBeNull();
    expect(() => ctx.workspace.registerFileDropTarget!(second, vi.fn())).toThrow(/disposed/); expect(fileDropTargets.resolve(second)).toBeNull();
  });

  it("reports handler failure through plugin errors and consumes the claimed drop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, element } = context(); const target = element();
    ctx.workspace.registerFileDropTarget!(target, () => { throw new Error("inspection failed"); });
    const delivery = dispatchFileDrop(fileDropTargets.resolve(target), ["/a.png"], "external", null);
    expect(delivery).not.toBeNull(); await expect(delivery!).resolves.toBeUndefined();
    expect(toastStore.toasts.map(toast => toast.message)).toContain("Drop Test: inspection failed");
  });

  it("reports a failing enabled predicate and blocks instead of falling through", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, element } = context(); const target = element();
    ctx.workspace.registerFileDropTarget!(target, vi.fn(), { enabled: () => { throw new Error("bad predicate"); } });
    expect(fileDropTargets.resolve(target)).toEqual({ type: "blocked" });
    expect(toastStore.toasts.map(toast => toast.message)).toContain("Drop Test: bad predicate");
  });

  it("does not invoke a registration retired after resolution", async () => {
    const { ctx, dispose, element } = context(); const targetElement = element(); const handler = vi.fn();
    ctx.workspace.registerFileDropTarget!(targetElement, handler); const target = fileDropTargets.resolve(targetElement);
    dispose(); await dispatchFileDrop(target, ["/a.png"], "external", null);
    expect(handler).not.toHaveBeenCalled();
  });
});


it("rejects host chrome and document.body without registering a target", () => {
  const { ctx } = context();
  for (const element of [dropElement("content"), dropElement("body")]) {
    expect(() => ctx.workspace.registerFileDropTarget!(element, vi.fn())).toThrow(/owned by.*drop-test/i);
    expect(fileDropTargets.resolve(element)).toBeNull();
  }
});

it("cannot disable another plugin's registered Inputs target", () => {
  const a = context(), b = createPluginContext("other-plugin"); disposers.push(b.dispose);
  const inputs = a.element();
  a.ctx.workspace.registerFileDropTarget!(inputs, vi.fn());
  expect(() => b.ctx.workspace.registerFileDropTarget!(inputs, vi.fn(), { enabled: () => false })).toThrow(/owned by.*other-plugin/i);
  expect(fileDropTargets.resolve(inputs)?.type).toBe("plugin");
});
