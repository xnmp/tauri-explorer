import { afterEach, expect, it } from "vitest";
import type { Component } from "svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
import { createModalOwnership,modalOwnership } from "$lib/state/modal-ownership.svelte";

afterEach(() => { dialogRegistry.clear(); dialogStore.closeAll(); });
it("managed cross-plugin navigation carries the dialog owner's dependencies",async()=>{
  const backend={invoke:()=>Promise.resolve("owner")};
  dialogRegistry.register({id:"provider.connections",component:(()=>{}) as unknown as Component,props:{backend}});
  const session=dialogRegistry.openManaged("provider.connections",{backend:{invoke:()=>Promise.resolve("caller")},draft:"caller value"});
  const props=dialogRegistry.openDialogs[0].props;
  expect(await (props.backend as typeof backend).invoke()).toBe("owner");
  expect(props.draft).toBe("caller value");
  dialogRegistry.close("provider.connections");expect(await session.result).toEqual({reason:"closed"});
});
it("only the most recent mounted surface owns focus; closing it resumes its caller",()=>{
  const ownership=createModalOwnership();const reservation=ownership.register(()=>{});
  const caller=ownership.registerSurface(()=>{});const target=ownership.registerSurface(()=>{});
  expect(caller.isTop()).toBe(false);expect(target.isTop()).toBe(true);
  target.release();expect(caller.isTop()).toBe(true);reservation();expect(caller.isTop()).toBe(true);
  caller.release();expect(ownership.hasOpen).toBe(false);
});
it("managed navigation preserves a caller dialog and resolves target closure",async()=>{
  const component=(()=>{}) as unknown as Component;
  dialogRegistry.register({id:"caller",component});dialogRegistry.register({id:"target",component});
  dialogRegistry.open("caller",{draft:"preserved"});
  const session=dialogRegistry.openManaged("target");
  dialogRegistry.close("target");expect(await session.result).toEqual({reason:"closed"});
  expect(dialogRegistry.openDialogs.find(dialog=>dialog.id==="caller")?.props).toEqual({draft:"preserved"});
});
it("owner disposal resolves a managed target and stale callers cannot close a new session",async()=>{
  const component=(()=>{}) as unknown as Component;
  const unregister=dialogRegistry.register({id:"target",component});const old=dialogRegistry.openManaged("target");
  unregister();expect(await old.result).toEqual({reason:"owner-disposed"});
  dialogRegistry.register({id:"target",component});const current=dialogRegistry.openManaged("target");
  old.close();expect(dialogRegistry.isOpen("target")).toBe(true);
  current.close();expect(await current.result).toEqual({reason:"caller-closed"});
});
it("late component closure cannot close a fresh opening of the same dialog",()=>{
  const component=(()=>{}) as unknown as Component;dialogRegistry.register({id:"target",component});
  dialogRegistry.open("target");const old=dialogRegistry.openDialogs[0].instanceId;
  dialogRegistry.close("target");dialogRegistry.open("target");
  dialogRegistry.closeInstance("target",old);expect(dialogRegistry.isOpen("target")).toBe(true);
});
it("caller modal retirement closes its managed target and settles the route",async()=>{
  const component=(()=>{}) as unknown as Component;dialogRegistry.register({id:"target",component});
  const caller=modalOwnership.registerSurface(()=>{});const session=dialogRegistry.openManaged("target");
  caller.release();expect(await session.result).toEqual({reason:"caller-closed"});expect(dialogRegistry.isOpen("target")).toBe(false);
});
it("a pending child save retains its suspended caller on global close",()=>{
  const ownership=createModalOwnership();let callerClosed=false;const caller=ownership.registerSurface(()=>{callerClosed=true;});
  const child=ownership.registerSurface(()=>{},()=>false);ownership.closeAll();expect(callerClosed).toBe(false);expect(child.isTop()).toBe(true);
  child.release();caller.release();
});
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

it("a surface that cannot close retains ownership until its work settles", async () => {
  const { createModalOwnership } = await import("$lib/state/modal-ownership.svelte");
  const ownership = createModalOwnership();
  let pending = true;
  let closed = 0;
  ownership.register(() => { closed++; }, () => !pending);
  ownership.closeAll();
  expect(closed).toBe(0);
  expect(ownership.hasOpen).toBe(true);
  pending = false;
  ownership.closeAll();
  expect(closed).toBe(1);
  expect(ownership.hasOpen).toBe(false);
});

it("a dirty mounted child retains ownership and its caller until it actually unmounts", () => {
  const ownership = createModalOwnership();
  let callerClosed = 0;
  let childConfirmation = 0;
  const caller = ownership.registerSurface(() => { callerClosed++; });
  const reservation = ownership.register(() => { throw new Error("Mounted child's reservation must not bypass its close guard"); });
  const child = ownership.registerSurface(() => { childConfirmation++; });
  ownership.closeAll();
  expect(childConfirmation).toBe(1);
  expect(callerClosed).toBe(0);
  expect(child.isTop()).toBe(true);
  expect(ownership.hasOpen).toBe(true);
  child.release(); reservation();
  expect(caller.isTop()).toBe(true);
  caller.release();
});

it("top closure is a request and cannot release busy or dirty surfaces", () => {
  const ownership = createModalOwnership();
  let pending = true;
  let requested = 0;
  const caller = ownership.registerSurface(() => { throw new Error("Suspended caller must remain open"); });
  const child = ownership.registerSurface(() => { requested++; }, () => !pending);
  expect(ownership.requestTopClose()).toBe(true);
  expect(requested).toBe(0);
  expect(child.isTop()).toBe(true);
  pending = false;
  expect(ownership.requestTopClose()).toBe(true);
  expect(requested).toBe(1);
  expect(child.isTop()).toBe(true);
  child.release(); caller.release();
  expect(ownership.requestTopClose()).toBe(false);
});

it("a reentrant mounted close request cannot close itself twice or its caller", () => {
  const ownership = createModalOwnership();
  let requested = 0;
  const caller = ownership.registerSurface(() => { throw new Error("Caller must remain open"); });
  const child = ownership.registerSurface(() => { requested++; ownership.closeAll(); });
  ownership.closeAll();
  expect(requested).toBe(1);
  expect(child.isTop()).toBe(true);
  child.release(); caller.release();
});

it("global store closure preserves built-in flags while a mounted child vetoes", () => {
  dialogStore.openSettings();
  let requested = 0;
  const child = modalOwnership.registerSurface(() => { requested++; });
  dialogStore.closeAll();
  expect(requested).toBe(1);
  expect(dialogStore.isSettingsOpen).toBe(true);
  expect(child.isTop()).toBe(true);
  child.release();
});
