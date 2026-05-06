/**
 * Position-based drop target resolution for macOS native drag sessions.
 * Tests that elementFromPoint → resolveDropTarget correctly identifies
 * folder entries, sidebar bookmarks, and background drops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("$lib/state/settings.svelte", () => ({
  settingsStore: { zoomLevel: 100 },
}));

import { resolveDropTarget, resolveDropTargetAtPoint, highlightTarget, clearHighlights, adjustForPointerZoom } from "$lib/composables/use-native-drop-target.svelte";

function makeElement(classes: string, attrs: Record<string, string> = {}, parent?: { classes: string; attrs?: Record<string, string> }) {
  const classSet = new Set(classes.split(" ").filter(Boolean));
  const parentClassSet = parent ? new Set(parent.classes.split(" ").filter(Boolean)) : null;

  function matches(set: Set<string>, pAttrs: Record<string, string>, selector: string): boolean {
    const classMatches = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(m => m[1]);
    const attrMatches = [...selector.matchAll(/\[([a-zA-Z0-9_-]+)\]/g)].map(m => m[1]);
    return classMatches.every(c => set.has(c)) && attrMatches.every(a => a in pAttrs);
  }

  const el = {
    className: classes,
    classList: {
      contains: (c: string) => classSet.has(c),
      add: (c: string) => classSet.add(c),
      remove: (c: string) => classSet.delete(c),
    },
    getAttribute: (name: string) => attrs[name] ?? (parent?.attrs?.[name]) ?? null,
    closest: (selector: string) => {
      if (matches(classSet, attrs, selector)) return el;
      if (parentClassSet && matches(parentClassSet, parent?.attrs ?? {}, selector)) {
        return { getAttribute: (name: string) => parent?.attrs?.[name] ?? null } as unknown as HTMLElement;
      }
      return null;
    },
  } as unknown as HTMLElement;
  return el;
}

function stubElementFromPoint(el: HTMLElement | null) {
  vi.stubGlobal("document", {
    elementFromPoint: vi.fn().mockReturnValue(el),
  });
}

describe("resolveDropTarget", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearHighlights();
  });

  it("returns folder target when over a directory entry", () => {
    const el = makeElement("entry-item directory", { "data-path": "/home/user/Documents" });
    stubElementFromPoint(el);

    const result = resolveDropTarget({ x: 100, y: 200 });
    expect(result).toEqual({ type: "folder", path: "/home/user/Documents" });
  });

  it("returns folder target when over a child of a directory entry", () => {
    const child = makeElement("icon", {}, { classes: "entry-item directory", attrs: { "data-path": "/home/user/Music" } });
    stubElementFromPoint(child);

    const result = resolveDropTarget({ x: 50, y: 50 });
    expect(result).toEqual({ type: "folder", path: "/home/user/Music" });
  });

  it("returns null for non-directory entry items", () => {
    const el = makeElement("entry-item", { "data-path": "/home/user/file.txt" });
    stubElementFromPoint(el);

    const result = resolveDropTarget({ x: 100, y: 200 });
    expect(result).toBeNull();
  });

  it("returns sidebar target when over .quick-access", () => {
    const el = makeElement("quick-access");
    stubElementFromPoint(el);

    const result = resolveDropTarget({ x: 30, y: 150 });
    expect(result).toEqual({ type: "sidebar" });
  });

  it("returns sidebar target when over a child of .quick-access", () => {
    const child = makeElement("nav-item", {}, { classes: "quick-access" });
    stubElementFromPoint(child);

    const result = resolveDropTarget({ x: 30, y: 150 });
    expect(result).toEqual({ type: "sidebar" });
  });

  it("returns background target when over .content", () => {
    const el = makeElement("content");
    stubElementFromPoint(el);

    const result = resolveDropTarget({ x: 400, y: 300 });
    expect(result).toEqual({ type: "background" });
  });

  it("returns null when elementFromPoint returns null", () => {
    stubElementFromPoint(null);

    const result = resolveDropTarget({ x: 0, y: 0 });
    expect(result).toBeNull();
  });

  it("adjusts coordinates for zoom level and devicePixelRatio", async () => {
    const el = makeElement("content");
    const mockFn = vi.fn().mockReturnValue(el);
    vi.stubGlobal("document", { elementFromPoint: mockFn });
    vi.stubGlobal("window", { devicePixelRatio: 2 });

    const settings = await import("$lib/state/settings.svelte");
    (settings.settingsStore as any).zoomLevel = 150;

    // 300 / 2 (dpr) / 1.5 (zoom) = 100, 450 / 2 / 1.5 = 150
    resolveDropTarget({ x: 300, y: 450 });
    expect(mockFn).toHaveBeenCalledWith(100, 150);

    (settings.settingsStore as any).zoomLevel = 100;
  });

  it("uses dpr=1 when window is undefined", async () => {
    const el = makeElement("content");
    const mockFn = vi.fn().mockReturnValue(el);
    vi.stubGlobal("document", { elementFromPoint: mockFn });
    vi.stubGlobal("window", { devicePixelRatio: 1 });

    const settings = await import("$lib/state/settings.svelte");
    (settings.settingsStore as any).zoomLevel = 100;

    resolveDropTarget({ x: 300, y: 450 });
    expect(mockFn).toHaveBeenCalledWith(300, 450);
  });
});

describe("highlightTarget / clearHighlights", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearHighlights();
  });

  it("adds drop-target class to directory under cursor", () => {
    const el = makeElement("entry-item directory", { "data-path": "/a" });
    stubElementFromPoint(el);

    highlightTarget({ x: 100, y: 100 });
    expect(el.classList.contains("drop-target")).toBe(true);
  });

  it("removes highlight from previous target when cursor moves", () => {
    const folder1 = makeElement("entry-item directory", { "data-path": "/a" });
    const folder2 = makeElement("entry-item directory", { "data-path": "/b" });

    stubElementFromPoint(folder1);
    highlightTarget({ x: 100, y: 100 });
    expect(folder1.classList.contains("drop-target")).toBe(true);

    stubElementFromPoint(folder2);
    highlightTarget({ x: 100, y: 200 });
    expect(folder1.classList.contains("drop-target")).toBe(false);
    expect(folder2.classList.contains("drop-target")).toBe(true);
  });

  it("clearHighlights removes the active highlight", () => {
    const el = makeElement("entry-item directory", { "data-path": "/x" });
    stubElementFromPoint(el);

    highlightTarget({ x: 50, y: 50 });
    expect(el.classList.contains("drop-target")).toBe(true);

    clearHighlights();
    expect(el.classList.contains("drop-target")).toBe(false);
  });
});

describe("pointer-zoom variants", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearHighlights();
  });

  it("adjustForPointerZoom only divides by zoom (not DPR)", async () => {
    const settings = await import("$lib/state/settings.svelte");
    (settings.settingsStore as any).zoomLevel = 200;

    const result = adjustForPointerZoom({ x: 400, y: 600 });
    expect(result).toEqual({ x: 200, y: 300 });

    (settings.settingsStore as any).zoomLevel = 100;
  });

  it("resolveDropTargetAtPoint uses pointer zoom (no DPR)", async () => {
    const el = makeElement("entry-item directory", { "data-path": "/docs" });
    const mockFn = vi.fn().mockReturnValue(el);
    vi.stubGlobal("document", { elementFromPoint: mockFn });

    const settings = await import("$lib/state/settings.svelte");
    (settings.settingsStore as any).zoomLevel = 150;

    const result = resolveDropTargetAtPoint(300, 450);
    // 300 / 1.5 = 200, 450 / 1.5 = 300 (no DPR division)
    expect(mockFn).toHaveBeenCalledWith(200, 300);
    expect(result).toEqual({ type: "folder", path: "/docs" });

    (settings.settingsStore as any).zoomLevel = 100;
  });
});
