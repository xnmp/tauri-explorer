import { afterEach, expect, it } from "vitest";
import type { Component } from "svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";

afterEach(() => { dialogRegistry.clear(); dialogStore.closeAll(); });
it("shortcut help owns modal input until closeAll", () => {
  dialogStore.openShortcuts();
  expect(dialogStore.hasModalOpen).toBe(true);
  dialogStore.closeAll();
  expect(dialogStore.isShortcutsOpen).toBe(false);
  expect(dialogStore.hasModalOpen).toBe(false);
});
it("plugin dialogs gate application input and release ownership on close", () => {
  dialogRegistry.register({ id: "test", component: (() => {}) as unknown as Component });
  dialogRegistry.open("test");
  expect(dialogStore.hasModalOpen).toBe(true);
  dialogRegistry.close("test");
  expect(dialogStore.hasModalOpen).toBe(false);
});
it("closing all dialogs also closes contributed dialogs", () => {
  dialogRegistry.register({ id: "test", component: (() => {}) as unknown as Component });
  dialogRegistry.open("test");
  dialogStore.closeAll();
  expect(dialogRegistry.isOpen("test")).toBe(false);
});

// A contributed dialog reserves input before it mounts; its rendered Modal
// also owns its focus lifetime. Closing the surface releases the reservation.
it("does not close an owner already released by its rendered surface", async () => {
  const { createModalOwnership } = await import("$lib/state/modal-ownership.svelte");
  const ownership = createModalOwnership();
  let closed = 0;
  const release = ownership.register(() => { closed++; });
  ownership.register(() => { closed++; release(); });
  ownership.closeAll();
  expect(closed).toBe(1);
  expect(ownership.hasOpen).toBe(false);
});

it("a close callback may close remaining dialogs without closing itself twice", async () => {
  const { createModalOwnership } = await import("$lib/state/modal-ownership.svelte");
  const ownership = createModalOwnership();
  let closed = 0;
  ownership.register(() => { if (++closed === 1) ownership.closeAll(); });
  ownership.closeAll();
  expect(closed).toBe(1);
});
