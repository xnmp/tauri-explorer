/**
 * Plugin dialog registry: register / open / close / dispose-by-id
 * (src/lib/plugins/dialog-registry.svelte.ts).
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Component } from "svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";

// Dummy components — only used as opaque identity values by the registry.
const CompA = (() => {}) as unknown as Component<any>;
const CompB = (() => {}) as unknown as Component<any>;

describe("dialog registry", () => {
  beforeEach(() => dialogRegistry.clear());

  it("opens a registered dialog with its props and component", () => {
    dialogRegistry.register({ id: "a", component: CompA });
    expect(dialogRegistry.openDialogs).toHaveLength(0);

    dialogRegistry.open("a", { sourcePath: "/img.png" });

    expect(dialogRegistry.openDialogs).toHaveLength(1);
    const [d] = dialogRegistry.openDialogs;
    expect(d.id).toBe("a");
    expect(d.component).toBe(CompA);
    expect(d.props).toEqual({ sourcePath: "/img.png" });
    expect(dialogRegistry.isOpen("a")).toBe(true);
  });

  it("ignores open() for an unknown id", () => {
    dialogRegistry.open("missing", {});
    expect(dialogRegistry.openDialogs).toHaveLength(0);
    expect(dialogRegistry.isOpen("missing")).toBe(false);
  });

  it("closes by id", () => {
    dialogRegistry.register({ id: "a", component: CompA });
    dialogRegistry.open("a", {});
    dialogRegistry.close("a");
    expect(dialogRegistry.openDialogs).toHaveLength(0);
    expect(dialogRegistry.isOpen("a")).toBe(false);
  });

  it("re-opening replaces props rather than duplicating", () => {
    dialogRegistry.register({ id: "a", component: CompA });
    dialogRegistry.open("a", { v: 1 });
    dialogRegistry.open("a", { v: 2 });
    expect(dialogRegistry.openDialogs).toHaveLength(1);
    expect(dialogRegistry.openDialogs[0].props).toEqual({ v: 2 });
  });

  it("keeps multiple distinct dialogs open independently", () => {
    dialogRegistry.register({ id: "a", component: CompA });
    dialogRegistry.register({ id: "b", component: CompB });
    dialogRegistry.open("a", {});
    dialogRegistry.open("b", {});
    expect(dialogRegistry.openDialogs.map((d) => d.id).sort()).toEqual(["a", "b"]);
  });

  it("dispose unregisters and closes an open dialog by id", () => {
    const dispose = dialogRegistry.register({ id: "a", component: CompA });
    dialogRegistry.open("a", {});
    expect(dialogRegistry.isOpen("a")).toBe(true);

    dispose();

    // Closed on dispose...
    expect(dialogRegistry.isOpen("a")).toBe(false);
    // ...and no longer openable.
    dialogRegistry.open("a", {});
    expect(dialogRegistry.openDialogs).toHaveLength(0);
  });
});
