import { afterEach, describe, expect, it, vi } from "vitest";
import type { Component } from "svelte";
import { createPaneDialogHost, type DialogPaneIdentity } from "$lib/state/pane-dialogs.svelte";
import { createModalOwnership } from "$lib/state/modal-ownership.svelte";
import { createDialogRegistry } from "$lib/plugins/dialog-registry.svelte";
import { createWindowTabsManager } from "$lib/state/window-tabs.svelte";
import { createPaneSessions } from "$lib/state/pane-sessions";

const component = (() => {}) as unknown as Component;
function fixture() {
  const ownership = createModalOwnership();
  const tab = Symbol("tab"), away = Symbol("other tab");
  const identities = new Map<string, DialogPaneIdentity>([
    ["a", { paneId: "a", tab, explorer: { selection: [] } }],
    ["b", { paneId: "b", tab, explorer: {} }],
    ["away", { paneId: "away", tab: away, explorer: {} }],
  ]);
  let activePane = "a", activeTab = tab;
  const host = createPaneDialogHost({
    ownership, readPane: id => identities.get(id) ?? null,
    activePaneId: () => activePane, activeTab: () => activeTab,
    activate: identity => { activePane = identity.paneId; activeTab = identity.tab; },
  });
  const registry = createDialogRegistry({ ownership, panes: host });
  const a = host.capture()!, b = host.capture("b")!;
  const scopeA = host.resolve(a), scopeB = host.resolve(b);
  return { host, registry, ownership, identities, a, b, scopeA, scopeB, tab,
    setActive(id: string) { activePane = id; activeTab = identities.get(id)!.tab; },
    active: () => activePane,
  };
}

describe("pane capture and retirement", () => {
  it("captures only an existing pane in the active explorer tab", () => {
    const f = fixture();
    expect(f.host.capture("missing")).toBeNull();
    expect(f.host.capture("away")).toBeNull();
    expect(Object.isFrozen(f.a)).toBe(true);
  });
  it("survives navigation, selection changes, active-pane changes and tab parking", () => {
    const f = fixture();
    Object.assign(f.identities.get("a")!.explorer, { selection: ["new"], path: "/new" });
    f.setActive("b"); expect(f.host.resolve(f.a)).toBe(f.scopeA);
    f.setActive("away"); expect(f.host.resolve(f.a)).toBe(f.scopeA);
    expect(f.host.isVisible(f.scopeA)).toBe(false);
    f.setActive("a"); expect(f.host.isActive(f.scopeA)).toBe(true);
  });
  it("rejects copied, foreign, retired and revived captures without retargeting", () => {
    const f = fixture();
    expect(() => f.host.resolve({ paneId: "a" })).toThrow(/stale|another window/);
    expect(() => fixture().host.resolve(f.a)).toThrow(/stale|another window/);
    f.host.releasePane("a");
    expect(() => f.host.resolve(f.a)).toThrow(/stale/);
    const revived = f.host.capture("a")!;
    expect(f.host.resolve(revived)).not.toBe(f.scopeA);
    f.identities.set("a", { ...f.identities.get("a")!, tab: Symbol("revived tab") });
    expect(() => f.host.resolve(revived)).toThrow(/stale/);
    f.setActive("a");
    const next = f.host.capture()!;
    f.identities.set("a", { ...f.identities.get("a")!, explorer: {} });
    expect(() => f.host.resolve(next)).toThrow(/stale/);
  });
  it("pane-sessions removal releases reservations and busy surfaces before cleanup awaits", async () => {
    const f = fixture();
    let finish!: () => void;
    const cleanup = new Promise<void>(done => { finish = done; });
    const sessions = createPaneSessions({ releasePane: f.host.releasePane, reportCleanupError: vi.fn() });
    sessions.create("a", () => ({ destroy: () => cleanup }), async () => {});
    f.registry.register({ id: "dialog", component });
    const session = f.registry.openManaged("dialog", {}, { scope: "pane", pane: f.a });
    const surface = f.ownership.registerSurface(() => {}, () => false, undefined, { scope: f.scopeA });
    sessions.remove("a");
    expect(f.registry.isOpen("dialog")).toBe(false);
    expect(surface.isTop()).toBe(false);
    expect(f.ownership.hasPaneOpen("a")).toBe(false);
    expect(() => f.host.resolve(f.a)).toThrow(/stale/);
    expect(await session.result).toEqual({ reason: "owner-disposed" });
    finish(); await sessions.dispose();
  });
});

describe("scoped dialog ownership", () => {
  it("does not attach a background caller to an unrelated pane's surface", async () => {
    const f = fixture(); f.registry.register({ id: "child", component });
    const unrelated = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeB });
    const child = f.registry.openManaged("child");
    unrelated.release(); expect(f.registry.isOpen("child")).toBe(true);
    child.close(); expect(await child.result).toEqual({ reason: "caller-closed" });
  });
  it("retiring a caller before its surface mounts closes its window child", async () => {
    const f = fixture(); f.registry.register({ id: "caller", component }); f.registry.register({ id: "child", component });
    f.registry.open("caller", {}, { scope: "pane", pane: f.a });
    const child = f.registry.openManaged("child");
    f.registry.close("caller"); expect(f.registry.isOpen("child")).toBe(false);
    expect(await child.result).toEqual({ reason: "caller-closed" });
    expect(f.ownership.hasOpen).toBe(false);
  });
  it("looks up a focused caller's own pane even when another pane is active", async () => {
    const f = fixture(); f.registry.register({ id: "child", component });
    const editor = {} as Element;
    vi.stubGlobal("document", { activeElement: editor });
    const caller = f.ownership.registerSurface(() => {}, undefined, undefined, {
      scope: f.scopeA, element: () => ({ contains: (node: Element) => node === editor }) as HTMLElement,
    });
    const unrelated = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeB });
    f.setActive("b"); const child = f.registry.openManaged("child");
    unrelated.release(); expect(f.registry.isOpen("child")).toBe(true);
    caller.release(); expect(await child.result).toEqual({ reason: "caller-closed" });
  });
  it.each(["caller-close", "pane-dispose"])("a pane caller's window child settles at %s", async route => {
    const f = fixture();
    f.registry.register({ id: "caller", component }); f.registry.register({ id: "child", component });
    f.registry.open("caller", {}, { scope: "pane", pane: f.a });
    const dialog = f.registry.openDialogs[0];
    const caller = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeA, presentation: dialog.presentation });
    const child = f.registry.openManaged("child");
    expect(f.ownership.hasOpen).toBe(true);
    if (route === "caller-close") f.registry.close("caller");
    else f.host.releasePane("a");
    expect(f.registry.isOpen("child")).toBe(false);
    expect(f.ownership.hasOpen).toBe(false);
    expect(await child.result).toEqual({ reason: "caller-closed" });
    caller.release();
  });
  it.each(["window", "pane-a"])("a %s caller owns a pane-b child independently of its destination", async from => {
    const f = fixture(); f.registry.register({ id: "child", component });
    const caller = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: from === "window" ? null : f.scopeA });
    const unrelated = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeB });
    const child = f.registry.openManaged("child", {}, { scope: "pane", pane: f.b, caller: f.host.capture()! });
    unrelated.release(); expect(f.registry.isOpen("child")).toBe(true);
    caller.release(); expect(f.registry.isOpen("child")).toBe(false);
    expect(await child.result).toEqual({ reason: "caller-closed" });
  });
  it("keeps two pane owners independent and suspends both at window reservation", () => {
    const f = fixture();
    const a = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeA });
    const b = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeB });
    expect(f.ownership.hasOpen).toBe(false);
    expect(a.isTop()).toBe(true); expect(b.isTop()).toBe(true);
    const releaseWindow = f.ownership.register(() => {});
    expect(f.ownership.hasOpen).toBe(true);
    expect(a.isTop()).toBe(false); expect(b.isTop()).toBe(false);
    releaseWindow(); expect(a.isTop()).toBe(true); expect(b.isTop()).toBe(true);
  });
  it("parked reservations and surfaces cannot own input or close requests", () => {
    const f = fixture(), close = vi.fn();
    f.ownership.register(close, undefined, { scope: f.scopeA, available: () => f.host.isVisible(f.scopeA) });
    const surface = f.ownership.registerSurface(close, undefined, undefined, {
      scope: f.scopeA, available: () => f.host.isVisible(f.scopeA),
    });
    f.setActive("away");
    expect(surface.isTop()).toBe(false);
    expect(f.ownership.hasPaneOpen("a")).toBe(false);
    expect(f.ownership.requestTopClose(undefined, f.scopeA)).toBe(false);
    expect(close).not.toHaveBeenCalled();
    f.setActive("a"); expect(surface.isTop()).toBe(true);
  });
  it("routes window first, event pane second, active pane only for background input", () => {
    const f = fixture();
    f.ownership.register(() => {}, undefined, { scope: f.scopeA });
    const fromPane = (paneId?: string) => ({ target: { closest: () => paneId ? { getAttribute: () => paneId } : null } }) as unknown as Event;
    expect(f.ownership.inputScope(fromPane("b"), "a")).toBeUndefined();
    expect(f.ownership.inputScope(fromPane("a"), "b")).toBe(f.scopeA);
    expect(f.ownership.inputScope(fromPane(), "a")).toBe(f.scopeA);
    f.ownership.register(() => {});
    expect(f.ownership.inputScope(fromPane("b"), "b")).toBeNull();
  });
  it("a pane close request respects its top guard without closing another pane", () => {
    const f = fixture(), closeA = vi.fn(), closeB = vi.fn();
    f.ownership.registerSurface(closeA, undefined, undefined, { scope: f.scopeA });
    f.ownership.registerSurface(closeB, undefined, undefined, { scope: f.scopeB });
    const blocked = f.ownership.registerSurface(() => {}, () => false, undefined, { scope: f.scopeA });
    expect(f.ownership.requestTopClose(undefined, f.scopeA)).toBe(true);
    expect(closeA).not.toHaveBeenCalled(); expect(closeB).not.toHaveBeenCalled();
    blocked.release(); f.ownership.requestTopClose(undefined, f.scopeA);
    expect(closeA).toHaveBeenCalledOnce(); expect(closeB).not.toHaveBeenCalled();
  });
  it("reopening across panes brings the original instance forward and preserves its props", async () => {
    const f = fixture(); f.registry.register({ id: "dialog", component });
    f.registry.open("dialog", { draft: "first" }, { scope: "pane", pane: f.a });
    const original = f.registry.openDialogs[0];
    f.setActive("b");
    f.registry.open("dialog", { draft: "replacement" }, { scope: "pane", pane: f.b });
    expect(f.registry.openDialogs[0]).toBe(original);
    expect(f.registry.openDialogs[0].props.draft).toBe("first");
    expect(f.active()).toBe("a");
    const one = f.registry.openManaged("dialog", {}, { scope: "pane", pane: f.b });
    const two = f.registry.openManaged("dialog", {}, { scope: "pane", pane: f.b });
    f.registry.close("dialog");
    expect(await one.result).toEqual({ reason: "closed" });
    expect(await two.result).toEqual({ reason: "closed" });
  });
  it("managed children follow their scoped caller rather than another pane's top surface", async () => {
    const f = fixture(); f.registry.register({ id: "child", component });
    const a = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeA });
    const b = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeB });
    const child = f.registry.openManaged("child", {}, { scope: "pane", pane: f.host.capture()! });
    b.release(); expect(f.registry.isOpen("child")).toBe(true);
    a.release(); expect(f.registry.isOpen("child")).toBe(false);
    expect(await child.result).toEqual({ reason: "caller-closed" });
  });
  it("a non-owner's reused session handle cannot close a pane dialog", async () => {
    const f = fixture(); f.registry.register({ id: "dialog", component });
    const owner = Symbol("owner"), observer = Symbol("observer");
    f.registry.open("dialog", {}, { scope: "pane", pane: f.a }, owner);
    const session = f.registry.openManaged("dialog", {}, { scope: "pane", pane: f.b }, observer);
    session.close();
    expect(f.registry.isOpen("dialog")).toBe(true);
    f.registry.close("dialog");
    expect(await session.result).toEqual({ reason: "closed" });
  });
  it.each(["pane", "window"] as const)("an awaited %s child retains its captured caller when B gains focus", async destination => {
    const f = fixture(); f.registry.register({ id: "child", component });
    const editorA = {} as Element, editorB = {} as Element;
    const doc = { activeElement: editorA }; vi.stubGlobal("document", doc);
    const a = f.ownership.registerSurface(() => {}, undefined, undefined, {
      scope: f.scopeA, element: () => ({ contains: (node: Element) => node === editorA }) as HTMLElement,
    });
    const b = f.ownership.registerSurface(() => {}, undefined, undefined, {
      scope: f.scopeB, element: () => ({ contains: (node: Element) => node === editorB }) as HTMLElement,
    });
    const caller = f.host.capture()!;
    await Promise.resolve(); f.setActive("b"); doc.activeElement = editorB;
    const child = f.registry.openManaged("child", {}, destination === "pane"
      ? { scope: "pane", pane: f.b, caller } : { scope: "window", caller });
    b.release(); expect(f.registry.isOpen("child")).toBe(true);
    a.release(); expect(f.registry.isOpen("child")).toBe(false);
    expect(await child.result).toEqual({ reason: "caller-closed" });
  });
  it("captures a window caller before it awaits and another window surface takes focus", async () => {
    const f = fixture(); f.registry.register({ id: "child", component });
    const a = f.ownership.registerSurface(() => {});
    const caller = f.host.capture()!;
    await Promise.resolve();
    const b = f.ownership.registerSurface(() => {});
    const child = f.registry.openManaged("child", {}, { scope: "window", caller });
    b.release(); expect(f.registry.isOpen("child")).toBe(true);
    a.release(); expect(f.registry.isOpen("child")).toBe(false);
    expect(await child.result).toEqual({ reason: "caller-closed" });
  });
  it("a retired captured caller settles immediately instead of adopting a same-pane replacement", async () => {
    const f = fixture(); f.registry.register({ id: "child", component });
    const a = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeA });
    const caller = f.host.capture()!;
    await Promise.resolve(); a.release();
    const replacement = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeA });
    const child = f.registry.openManaged("child", {}, { scope: "window", caller });
    expect(f.registry.isOpen("child")).toBe(false);
    expect(await child.result).toEqual({ reason: "caller-closed" });
    expect(replacement.isTop()).toBe(true);
  });
  it.each(["window", "pane"] as const)("a captured background caller cannot adopt a later dialog (%s child)", async destination => {
    const f = fixture(); f.registry.register({ id: "child", component });
    const caller = f.host.capture()!;
    await Promise.resolve();
    const later = f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeA });
    const child = f.registry.openManaged("child", {}, destination === "pane"
      ? { scope: "pane", pane: caller } : { scope: "window", caller });
    later.release(); expect(f.registry.isOpen("child")).toBe(true);
    child.close(); expect(await child.result).toEqual({ reason: "caller-closed" });
  });
  it.each(["parked", "window-suspended"])("managed children retain a %s caller's lifetime across asynchronous opening", async suspension => {
    const f = fixture(); f.registry.register({ id: "child", component });
    const editor = {} as Element;
    vi.stubGlobal("document", { activeElement: editor });
    const caller = f.ownership.registerSurface(() => {}, undefined, undefined, {
      scope: f.scopeA, available: () => f.host.isVisible(f.scopeA) && !f.ownership.hasOpen,
      element: () => ({ contains: (node: Element) => node === editor }) as HTMLElement,
    });
    const captured = f.host.capture()!;
    if (suspension === "parked") f.setActive("away");
    else f.ownership.register(() => {});
    const child = f.registry.openManaged("child", {}, { scope: "pane", pane: captured });
    caller.release();
    expect(f.registry.isOpen("child")).toBe(false);
    expect(await child.result).toEqual({ reason: "caller-closed" });
  });
  it("invalid captures are errors even when the same id already has a valid opening", () => {
    const f = fixture(); f.registry.register({ id: "dialog", component });
    f.registry.open("dialog", { draft: "first" }, { scope: "pane", pane: f.a });
    const original = f.registry.openDialogs[0];
    expect(() => f.registry.open("dialog", {}, { scope: "pane", pane: { paneId: "a" } })).toThrow(/stale/);
    expect(f.registry.openDialogs[0]).toBe(original);
  });
  it("rejected activation leaves no ownership or managed session and permits a later retry", async () => {
    const f = fixture();
    const panes: typeof f.host = { ...f.host, activate: () => { throw new Error("Window is closing"); } };
    const registry = createDialogRegistry({ ownership: f.ownership, panes });
    registry.register({ id: "dialog", component });
    expect(() => registry.open("dialog", {}, { scope: "pane", pane: f.a })).toThrow("Window is closing");
    expect(() => registry.openManaged("dialog", {}, { scope: "pane", pane: f.a })).toThrow("Window is closing");
    expect(f.ownership.hasPaneOpen("a")).toBe(false);
    expect(registry.isOpen("dialog")).toBe(false);
    panes.activate = f.host.activate;
    const session = registry.openManaged("dialog", {}, { scope: "pane", pane: f.a });
    registry.close("dialog"); expect(await session.result).toEqual({ reason: "closed" });
    registry.clear(); expect(f.ownership.hasPaneOpen("a")).toBe(false);
  });
  it("contribution disposal settles only its managed pane dialog", async () => {
    const f = fixture();
    const unregister = f.registry.register({ id: "a", component });
    f.registry.register({ id: "b", component });
    const session = f.registry.openManaged("a", {}, { scope: "pane", pane: f.a });
    f.registry.open("b", {}, { scope: "pane", pane: f.b });
    unregister(); expect(await session.result).toEqual({ reason: "owner-disposed" });
    expect(f.registry.isOpen("b")).toBe(true);
    expect(f.ownership.hasPaneOpen("a")).toBe(false);
  });
});

// Observe DOM reparenting without a browser: these are the platform operations
// used by the production mount service, not a second portal implementation.
function element() {
  const children = new Set<HTMLElement>();
  const node = {
    hidden: false, inert: false, parentElement: null as HTMLElement | null,
    append(child: HTMLElement) {
      child.remove(); children.add(child); Object.assign(child, { parentElement: node as unknown as HTMLElement });
    },
    remove() { (node.parentElement as unknown as { children: Set<HTMLElement> } | null)?.children.delete(node as unknown as HTMLElement); node.parentElement = null; },
    children,
  };
  return node as unknown as HTMLElement;
}

it("portals the same container, parks before slot removal, and survives stale slot teardown", () => {
  const f = fixture(), parking = element(), container = element(), first = element(), replacement = element();
  parking.hidden = true; parking.inert = true;
  const detach = f.host.registerSlot("a", first);
  const destroy = f.host.mount(f.scopeA, container, parking);
  expect(container.parentElement).toBe(first);
  detach(); expect(container.parentElement).toBe(parking);
  expect(container.parentElement?.hidden).toBe(true); expect(container.parentElement?.inert).toBe(true);
  f.host.registerSlot("a", replacement); detach();
  expect(container.parentElement).toBe(replacement);
  expect(container.hidden).toBe(false); expect(container.inert).toBe(false);
  f.host.releasePane("a"); expect(container.parentElement).toBe(parking);
  destroy(); expect(container.parentElement).toBeNull();
});

it("pane activation leaves a former dialog editor for an uncovered pane's focus surface", () => {
  const f = fixture(), focusB = vi.fn();
  const slot = { ownerDocument: { activeElement: { closest: () => ({}) } }, append: vi.fn() } as unknown as HTMLElement;
  f.host.registerSlot("b", slot, focusB);
  f.setActive("b"); f.host.focusPane("b"); expect(focusB).toHaveBeenCalledOnce();
  const focusDialog = vi.fn();
  f.ownership.registerSurface(() => {}, undefined, undefined, { scope: f.scopeB, focus: focusDialog });
  f.host.focusPane("b"); expect(focusDialog).toHaveBeenCalledOnce(); expect(focusB).toHaveBeenCalledOnce();
  f.ownership.register(() => {});
  f.host.focusPane("b"); expect(focusDialog).toHaveBeenCalledOnce(); expect(focusB).toHaveBeenCalledOnce();
});

it("a surviving pane mount accepts a fresh lifetime after native-close recovery", () => {
  const f = fixture(), slot = element(), parking = element(), container = element();
  const unregisterSlot = f.host.registerSlot("a", slot);
  f.host.releasePane("a");
  const recovered = f.host.capture("a")!, owner = f.host.resolve(recovered);
  expect(() => f.host.resolve(f.a)).toThrow(/stale/);
  expect(f.host.slot(owner)).toBe(slot);
  const unmount = f.host.mount(owner, container, parking);
  expect(container.parentElement).toBe(slot);
  unregisterSlot(); expect(container.parentElement).toBe(parking);
  expect(f.host.slot(owner)).toBeUndefined(); unmount();
});

const managers: ReturnType<typeof createWindowTabsManager>[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(managers.splice(0).map(manager => manager.dispose())); });
it("real manager pane/tab closure and transfer completion synchronously invalidate captures", () => {
  localStorage.clear();
  const manager = createWindowTabsManager(); managers.push(manager);
  const tab = manager.init("/home/user", true)!;
  const original = manager.paneDialogs.capture()!;
  manager.splitPane("right");
  const sibling = manager.paneDialogs.capture()!;
  manager.closePane(sibling.paneId);
  expect(() => manager.paneDialogs.resolve(sibling)).toThrow(/stale/);
  expect(manager.paneDialogs.resolve(original).paneId).toBe(original.paneId);
  manager.createTab("/home/user/Pictures");
  const other = manager.paneDialogs.capture()!;
  manager.closeActiveTab();
  expect(() => manager.paneDialogs.resolve(other)).toThrow(/stale/);
  const transfer = manager.beginTabTransfer(tab.id)!;
  transfer.complete();
  expect(() => manager.paneDialogs.resolve(original)).toThrow(/stale/);
});

it.each(["last-pane", "native-window"])("%s close invalidates captures before native destruction settles", async route => {
  localStorage.clear();
  let finish!: () => void;
  const destruction = new Promise<void>(done => { finish = done; });
  const manager = createWindowTabsManager({ nativeWindow: () => ({
    destroy: () => destruction, onCloseRequested: async () => () => {},
  }) });
  managers.push(manager); manager.init("/home/user", true);
  const handle = manager.paneDialogs.capture()!;
  if (route === "last-pane") manager.closePane(handle.paneId);
  else void manager.requestWindowClose();
  expect(() => manager.paneDialogs.resolve(handle)).toThrow(/stale/);
  await Promise.resolve();
  finish();
  await manager.requestWindowClose();
});
