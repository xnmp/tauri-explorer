import { beforeEach, expect, it, vi } from "vitest";
import type { Component } from "svelte";
let createPluginContext: typeof import("$lib/plugins/api").createPluginContext;
let dialogRegistry: typeof import("$lib/plugins/dialog-registry.svelte").dialogRegistry;
let windowTabsManager: typeof import("$lib/state/window-tabs.svelte").windowTabsManager;
let createWindowTabsManager: typeof import("$lib/state/window-tabs.svelte").createWindowTabsManager;
let dialogStore: typeof import("$lib/state/dialogs.svelte").dialogStore;
let toastStore: typeof import("$lib/state/toast.svelte").toastStore;
let modalOwnership: typeof import("$lib/state/modal-ownership.svelte").modalOwnership;

beforeEach(async () => {
  vi.resetModules();
  ({ createPluginContext } = await import("$lib/plugins/api"));
  ({ dialogRegistry } = await import("$lib/plugins/dialog-registry.svelte"));
  ({ windowTabsManager, createWindowTabsManager } = await import("$lib/state/window-tabs.svelte"));
  ({ dialogStore } = await import("$lib/state/dialogs.svelte"));
  ({ toastStore } = await import("$lib/state/toast.svelte"));
  ({ modalOwnership } = await import("$lib/state/modal-ownership.svelte"));
});

it.each(["id-close", "dispose"])("a plugin reusing another plugin's pane dialog cannot retire it by %s", async route => {
  windowTabsManager.init("/home/user", true);
  const a = createPluginContext("dialog-owner-a"), b = createPluginContext("dialog-observer-b");
  let release = () => {};
  try {
    a.ctx.registerDialog({ id: "owned.dialog", component: (() => {}) as unknown as Component });
    const pane = a.ctx.workspace.capturePane!()!;
    a.ctx.openDialog("owned.dialog", {}, { scope: "pane", pane });
    const opened = dialogRegistry.openDialogs.find(dialog => dialog.id === "owned.dialog")!;
    release = modalOwnership.registerSurface(() => a.ctx.closeDialog("owned.dialog"), () => false, undefined,
      { scope: opened.scope, presentation: opened.presentation }).release;
    const result = b.ctx.presentation!.openDialog("owned.dialog", {}, { scope: "pane", pane });
    if (route === "id-close") b.ctx.closeDialog("owned.dialog");
    else b.dispose();
    expect(dialogRegistry.isOpen("owned.dialog")).toBe(true);
    expect(modalOwnership.requestTopClose(undefined, opened.scope)).toBe(true);
    expect(dialogRegistry.isOpen("owned.dialog")).toBe(true);
    a.dispose();
    expect(await result).toEqual({ reason: "owner-disposed" });
  } finally {
    release(); a.dispose(); b.dispose(); dialogRegistry.clear(); dialogStore.closeAll();
    await windowTabsManager.dispose();
  }
});

it("an awaited pane child follows captured caller A after focus moves to B's dialog", async () => {
  windowTabsManager.init("/home/user", true);
  const plugin = createPluginContext("async-caller");
  const releases: (() => void)[] = [];
  const previousDocument = globalThis.document;
  try {
    for (const id of ["caller.a", "caller.b", "child"]) plugin.ctx.registerDialog({ id, component: (() => {}) as unknown as Component });
    const a = plugin.ctx.workspace.capturePane!()!;
    windowTabsManager.splitPane("right");
    const b = plugin.ctx.workspace.capturePane!()!;
    plugin.ctx.openDialog("caller.a", {}, { scope: "pane", pane: a });
    plugin.ctx.openDialog("caller.b", {}, { scope: "pane", pane: b });
    const editorA = {} as Element, editorB = {} as Element;
    const doc = { activeElement: editorA };
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
    for (const [id, editor] of [["caller.a", editorA], ["caller.b", editorB]] as const) {
      const dialog = dialogRegistry.openDialogs.find(dialog => dialog.id === id)!;
      releases.push(modalOwnership.registerSurface(() => {}, undefined, undefined, {
        scope: dialog.scope, presentation: dialog.presentation,
        element: () => ({ contains: (node: Element) => node === editor }) as HTMLElement,
      }).release);
    }
    windowTabsManager.setActivePane(a.paneId);
    const captured = plugin.ctx.workspace.capturePane!()!;
    let resume!: () => void;
    const ready = new Promise<void>(done => { resume = done; });
    const child = (async () => {
      await ready;
      return plugin.ctx.presentation!.openDialog("child", {}, { scope: "pane", pane: captured });
    })();
    windowTabsManager.setActivePane(b.paneId); doc.activeElement = editorB;
    resume(); await Promise.resolve();
    expect(dialogRegistry.openDialogs.find(dialog => dialog.id === "child")?.scope?.paneId).toBe(a.paneId);
    plugin.ctx.closeDialog("caller.b"); releases[1]();
    expect(dialogRegistry.isOpen("child")).toBe(true);
    plugin.ctx.closeDialog("caller.a");
    expect(dialogRegistry.isOpen("child")).toBe(false);
    expect(await child).toEqual({ reason: "caller-closed" });
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    releases.forEach(release => release()); plugin.dispose(); dialogRegistry.clear(); dialogStore.closeAll();
    await windowTabsManager.dispose();
  }
});

it("host plugin APIs capture scope, report invalid handles and dispose managed pane sessions", async () => {
  localStorage.clear();
  windowTabsManager.init("/home/user", true);
  const plugin = createPluginContext("pane-api-test");
  const error = vi.spyOn(toastStore, "error");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    plugin.ctx.registerDialog({ id: "pane-api-test.dialog", component: (() => {}) as unknown as Component });
    const a = plugin.ctx.workspace.capturePane!()!;
    windowTabsManager.splitPane("right");
    plugin.ctx.openDialog("pane-api-test.dialog", { draft: "captured before await" }, { scope: "pane", pane: a });
    expect(windowTabsManager.activePaneId).toBe(a.paneId);
    expect(dialogStore.hasModalOpen).toBe(false);
    expect(dialogStore.isPaneBlocked(a.paneId)).toBe(true);
    expect(dialogRegistry.openDialogs[0].props.draft).toBe("captured before await");
    plugin.ctx.closeDialog("pane-api-test.dialog");
    const foreign = createWindowTabsManager(); foreign.init("/home/user", true);
    const foreignHandle = foreign.paneDialogs.capture()!;
    expect(() => plugin.ctx.openDialog("pane-api-test.dialog", {}, { scope: "pane", pane: foreignHandle })).toThrow(/another window/);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/another window/));
    await foreign.dispose();
    const result = plugin.ctx.presentation!.openDialog("pane-api-test.dialog", {}, { scope: "pane", pane: a });
    windowTabsManager.closePane(a.paneId);
    expect(dialogRegistry.isOpen("pane-api-test.dialog")).toBe(false);
    expect(await result).toEqual({ reason: "owner-disposed" });
    await expect(plugin.ctx.presentation!.openDialog("pane-api-test.dialog", {}, { scope: "pane", pane: a })).rejects.toThrow(/stale/);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/stale/));
    const b = plugin.ctx.workspace.capturePane!()!;
    const managed = plugin.ctx.presentation!.openDialog("pane-api-test.dialog", {}, { scope: "pane", pane: b });
    plugin.dispose(); await managed;
    expect(dialogRegistry.isOpen("pane-api-test.dialog")).toBe(false);
    expect(plugin.ctx.workspace.capturePane!()).toBeNull();
    expect(() => plugin.ctx.openDialog("pane-api-test.dialog", {}, { scope: "pane", pane: b })).toThrow(/disposed/);
  } finally {
    plugin.dispose(); dialogRegistry.clear(); dialogStore.closeAll();
    error.mockRestore(); log.mockRestore(); await windowTabsManager.dispose();
  }
});

it.each(["caller-close", "pane-close", "plugin-dispose", "editor-close"])("managed image editor follows pane caller lifetime: %s", async route => {
  windowTabsManager.init("/home/user", true);
  const plugin = createPluginContext("pane-editor-caller");
  const component = (() => {}) as unknown as Component;
  let release = () => {};
  try {
    plugin.ctx.registerDialog({ id: "editor.caller", component });
    plugin.ctx.registerImageEditorTool({ id: "caller.tool", title: "Tool", component, when: () => true });
    const pane = plugin.ctx.workspace.capturePane!()!;
    windowTabsManager.splitPane("right");
    plugin.ctx.openDialog("editor.caller", {}, { scope: "pane", pane });
    const caller = dialogRegistry.openDialogs.find(dialog => dialog.id === "editor.caller")!;
    release = modalOwnership.registerSurface(() => {}, undefined, undefined, { scope: caller.scope, presentation: caller.presentation }).release;
    const editor = plugin.ctx.presentation!.openImageEditor!({ path: "/home/user/image.png", tool: "caller.tool" });
    expect(dialogStore.imageEditorTarget?.path).toBe("/home/user/image.png");
    if (route === "caller-close") plugin.ctx.closeDialog("editor.caller");
    if (route === "pane-close") windowTabsManager.closePane(pane.paneId);
    if (route === "plugin-dispose") plugin.dispose();
    if (route === "editor-close") dialogStore.closeImageEditor();
    expect(dialogStore.imageEditorTarget).toBeNull();
    await editor;
    if (route === "editor-close") expect(dialogRegistry.isOpen("editor.caller")).toBe(true);
  } finally {
    release(); plugin.dispose(); dialogRegistry.clear(); dialogStore.closeAll(); await windowTabsManager.dispose();
  }
});
