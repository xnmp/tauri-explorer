import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileDropTargets, fileDropTargets } from "$lib/state/file-drop-targets.svelte";
import { resolveDropTarget, resolveDropTargetAtPoint, highlightTarget, highlightTargetAtPoint, clearHighlights } from "$lib/composables/use-native-drop-target.svelte";
import { dropElement } from "../helpers/drop-element";
import { modalOwnership } from "$lib/state/modal-ownership.svelte";

const disposers: (() => void)[] = [];
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); clearHighlights(); vi.unstubAllGlobals(); });
function hit(element: Element) { vi.stubGlobal("document", { elementFromPoint: vi.fn(() => element), documentElement: { style: { zoom: "150%" } } }); }
function register(element: HTMLElement, enabled?: () => boolean) { disposers.push(fileDropTargets.register(element, vi.fn(), { enabled })); }

describe("file drop target resolution and feedback", () => {
  it("resolves the nearest registered ancestor before a built-in directory or terminal", () => {
    const outer = dropElement("terminal-panel");
    const target = dropElement("", {}, outer);
    const folder = dropElement("entry-item directory", { "data-path": "/folder" }, target);
    register(outer); register(target); hit(dropElement("", {}, folder));
    expect(resolveDropTargetAtPoint(20, 30)).toMatchObject({ type: "plugin", registration: { element: target } });
    highlightTargetAtPoint(20, 30);
    expect(target.classList.contains("drop-target")).toBe(true);
    expect(outer.classList.contains("drop-target")).toBe(false);
    expect(folder.classList.contains("drop-target")).toBe(false);
  });

  it("consumes a disabled inner target instead of using the outer target", () => {
    const outer = dropElement(); const inner = dropElement("", {}, outer);
    register(outer); register(inner, () => false); hit(dropElement("", {}, inner));
    expect(resolveDropTargetAtPoint(20, 30)).toEqual({ type: "blocked" });
    highlightTargetAtPoint(20, 30);
    expect(inner.classList.contains("drop-target")).toBe(false);
    expect(outer.classList.contains("drop-target")).toBe(false);
  });

  it("allows enabled targets inside a modal while consuming the remaining modal area", () => {
    const overlay = dropElement("modal-overlay"); const target = dropElement("", {}, overlay);
    disposers.push(modalOwnership.registerSurface(() => {}, undefined, undefined, { element: () => overlay }).release);
    register(target); hit(dropElement("", {}, target));
    expect(resolveDropTargetAtPoint(1, 2)?.type).toBe("plugin");
    hit(dropElement("", {}, overlay));
    expect(resolveDropTargetAtPoint(1, 2)).toEqual({ type: "blocked" });
  });

  it.each([{ inert: "" }, { hidden: "" }])("blocks a registered target under a parked surface: %j", attrs => {
    const root = dropElement("", attrs as unknown as Record<string, string>); const target = dropElement("", {}, root);
    register(target); hit(target);
    expect(resolveDropTargetAtPoint(1, 2)).toEqual({ type: "blocked" });
    highlightTargetAtPoint(1, 2);
    expect(target.classList.contains("drop-target")).toBe(false);
  });

  it("accepts a drop on an aria-hidden decorative child of a plugin target", () => {
    const target = dropElement(); register(target);
    hit(dropElement("", { "aria-hidden": "true" }, target));
    expect(resolveDropTargetAtPoint(1, 2)).toMatchObject({ type: "plugin", registration: { element: target } });
    highlightTargetAtPoint(1, 2);
    expect(target.classList.contains("drop-target")).toBe(true);
  });

  it("resolves a Details folder through its aria-hidden icon", () => {
    const folder = dropElement("entry-item directory", { "data-path": "/folder" });
    hit(dropElement("", { "aria-hidden": "true" }, folder));
    expect(resolveDropTargetAtPoint(1, 2)).toEqual({ type: "folder", path: "/folder" });
  });

  it("blocks unregistered pane dialog content using its explicit surface marker", () => {
    hit(dropElement("", {}, dropElement("pane-dialog-container")));
    expect(resolveDropTargetAtPoint(1, 2)).toEqual({ type: "blocked" });
  });

  it("blocks suspended and unregistered plugin view surfaces", () => {
    for (const name of ["suspended", "plugin-file-view"]) {
      hit(dropElement(name));
      expect(resolveDropTargetAtPoint(1, 2)).toEqual({ type: "blocked" });
    }
  });

  it("disposes idempotently, removing eligibility and highlight", () => {
    const registry = createFileDropTargets(); const target = dropElement();
    const dispose = registry.register(target, vi.fn()); target.classList.add("drop-target");
    expect(registry.resolve(target)?.type).toBe("plugin");
    dispose(); dispose();
    expect(registry.resolve(target)).toBeNull();
    expect(target.classList.contains("drop-target")).toBe(false);
  });

  it("keeps a replacement registration when the old disposer runs", () => {
    const registry = createFileDropTargets(); const target = dropElement();
    const old = registry.register(target, vi.fn()); const handler = vi.fn(); registry.register(target, handler);
    old(); old(); expect(registry.resolve(target)).toMatchObject({ type: "plugin", registration: { handler } });
  });

  it("does not deliver disconnected registrations", () => {
    const registry = createFileDropTargets(); const target = dropElement(); registry.register(target, vi.fn());
    Object.assign(target, { isConnected: false }); expect(registry.resolve(target)).toEqual({ type: "blocked" });
  });

  it("uses DPR once for native hit tests and raw client coordinates at CSS zoom", () => {
    const target = dropElement(); register(target); hit(target); vi.stubGlobal("window", { devicePixelRatio: 2 });
    resolveDropTarget({ x: 300, y: 450 }); highlightTarget({ x: 300, y: 450 });
    expect(document.elementFromPoint).toHaveBeenLastCalledWith(150, 225);
    resolveDropTargetAtPoint(300, 450); highlightTargetAtPoint(300, 450);
    expect(document.elementFromPoint).toHaveBeenLastCalledWith(300, 450);
    clearHighlights(); expect(target.classList.contains("drop-target")).toBe(false);
  });
});


describe("position feedback ownership", () => {
  it("highlights only the concrete surface even when another names the same folder", async () => {
    const { createPositionDropFeedback } = await import("$lib/state/file-drop-targets.svelte");
    const feedback = createPositionDropFeedback();
    const row = dropElement("entry-item directory", { "data-path": "/same" });
    const panel = dropElement("peek-drop-target", { "data-path": "/same" });
    feedback.set(panel);
    expect(feedback.matches(panel)).toBe(true);
    expect(feedback.matches(row)).toBe(false);
    feedback.set(row);
    expect(feedback.matches(panel)).toBe(false);
    expect(feedback.matches(row)).toBe(true);
    feedback.set(null);
    expect(feedback.matches(row)).toBe(false);
    expect(feedback.matches(null)).toBe(false);
    expect(feedback.matches(undefined)).toBe(false);
  });
});
