/**
 * The document root reports a full-window overlay inside the window body
 * while at least one is mounted (#1859).
 */
import { describe, expect, it } from "vitest";
import { WINDOW_OVERLAY_ATTRIBUTE, windowOverlay } from "$lib/composables/window-overlay";

function fakeDocument() {
  const attributes = new Set<string>();
  const root = {
    toggleAttribute: (name: string, force: boolean) => {
      if (force) attributes.add(name);
      else attributes.delete(name);
      return force;
    },
  };
  const node = () => ({ ownerDocument: { documentElement: root } }) as unknown as HTMLElement;
  return { open: () => attributes.has(WINDOW_OVERLAY_ATTRIBUTE), node };
}

describe("windowOverlay (#1859)", () => {
  it("marks the root from the first overlay until the last one closes", () => {
    const doc = fakeDocument();
    expect(doc.open()).toBe(false);
    const menu = windowOverlay(doc.node());
    expect(doc.open()).toBe(true);
    const dialog = windowOverlay(doc.node());
    menu.destroy();
    expect(doc.open()).toBe(true);
    dialog.destroy();
    expect(doc.open()).toBe(false);
  });

  it("holds nothing while inactive, and follows updates", () => {
    const doc = fakeDocument();
    const scoped = windowOverlay(doc.node(), false);
    expect(doc.open()).toBe(false);
    scoped.update(true);
    expect(doc.open()).toBe(true);
    scoped.update(false);
    expect(doc.open()).toBe(false);
    scoped.destroy();
    expect(doc.open()).toBe(false);
  });

  it("counts a repeated update or destroy once", () => {
    const doc = fakeDocument();
    const a = windowOverlay(doc.node());
    const b = windowOverlay(doc.node());
    a.update(true);
    a.destroy();
    a.destroy();
    expect(doc.open()).toBe(true);
    b.destroy();
    expect(doc.open()).toBe(false);
  });
});
