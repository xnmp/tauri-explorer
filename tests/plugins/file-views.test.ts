/**
 * SDK 2 file views, Preview-info sections and Preview targets: registration,
 * resolution, pane scoping and disposal contracts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { fileViewRegistry } from "$lib/plugins/file-view-registry.svelte";
import { previewInfoRegistry, type PreviewSubject } from "$lib/plugins/preview-registry.svelte";
import { createPluginContext } from "$lib/plugins/api";
import { normalizePersistedState, type PersistedNode } from "$lib/state/window-tabs-persistence";
import { SUPPORTED_SDK_VERSIONS } from "$lib/plugins/installed";
import type { FileEntry } from "$lib/domain/file";

const Component = (() => {}) as never;
const file: FileEntry = { name: "a.png", path: "/pictures/a.png", kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" };

afterEach(() => { fileViewRegistry.clear(); previewInfoRegistry.clear(); });

describe("file view registry", () => {
  it("resolves a chosen view only where it applies", () => {
    const traced = new Set(["/pictures"]);
    const dispose = fileViewRegistry.register("trace", { id: "trace.view", title: "Trace", component: Component, available: (dir) => traced.has(dir) });
    expect(fileViewRegistry.resolve("trace.view", "/pictures")?.id).toBe("trace.view");
    expect(fileViewRegistry.resolve("trace.view", "/documents")).toBeNull();
    expect(fileViewRegistry.resolve(null, "/pictures")).toBeNull();
    expect(fileViewRegistry.resolve("trace.view", "trash://")).toBeNull();
    dispose();
    expect(fileViewRegistry.resolve("trace.view", "/pictures")).toBeNull();
  });

  it("treats a throwing availability check as unavailable", () => {
    fileViewRegistry.register("trace", { id: "trace.view", title: "Trace", component: Component, available: () => { throw new Error("boom"); } });
    expect(fileViewRegistry.resolve("trace.view", "/pictures")).toBeNull();
  });

  it("rejects malformed and duplicate view ids", () => {
    expect(() => fileViewRegistry.register("x", { id: "../evil", title: "x", component: Component })).toThrow(/Invalid/);
    expect(() => fileViewRegistry.register("x", { id: "", title: "x", component: Component })).toThrow(/Invalid/);
    expect(() => fileViewRegistry.register("x", { id: "x".repeat(200), title: "x", component: Component })).toThrow(/Invalid/);
    fileViewRegistry.register("x", { id: "x.view", title: "x", component: Component });
    expect(() => fileViewRegistry.register("y", { id: "x.view", title: "y", component: Component })).toThrow(/already/);
  });
});

describe("plugin context SDK 2 contributions", () => {
  it("requires plugin-namespaced view ids and removes views on deactivation", () => {
    const { ctx, dispose } = createPluginContext("trace");
    expect(() => ctx.registerFileView!({ id: "other.view", title: "X", component: Component })).toThrow(/must be named/);
    ctx.registerFileView!({ id: "trace.view", title: "Trace", component: Component });
    ctx.registerPreviewInfo!({ id: "info", component: Component, when: () => true });
    expect(fileViewRegistry.get("trace.view")).not.toBeNull();
    expect(previewInfoRegistry.itemsFor({ kind: "file", entry: file, paneId: null })).toHaveLength(1);
    dispose();
    expect(fileViewRegistry.get("trace.view")).toBeNull();
    expect(previewInfoRegistry.itemsFor({ kind: "file", entry: file, paneId: null })).toHaveLength(0);
  });

  it("refuses to toggle a view another plugin registered, or none registered", () => {
    const other = createPluginContext("other");
    other.ctx.registerFileView!({ id: "other.view", title: "Other", component: Component });
    const { ctx, dispose } = createPluginContext("trace");
    expect(() => ctx.workspace.toggleFileView!("other.view")).toThrow(/not registered by trace/);
    expect(() => ctx.workspace.toggleFileView!("trace.missing")).toThrow(/not registered by trace/);
    dispose(); other.dispose();
  });

  it("keeps dotted plugin ids from claiming each other's view names", () => {
    const acme = createPluginContext("acme");
    expect(() => acme.ctx.registerFileView!({ id: "acme.trace.view", title: "X", component: Component })).toThrow(/must be named/);
    const nested = createPluginContext("acme.trace");
    nested.ctx.registerFileView!({ id: "acme.trace.view", title: "Trace", component: Component });
    expect(fileViewRegistry.get("acme.trace.view")?.pluginId).toBe("acme.trace");
    acme.dispose(); nested.dispose();
  });
});

describe("Preview-info sections", () => {
  it("offers a target only to its owning plugin's sections", () => {
    previewInfoRegistry.register("trace", { id: "a", component: Component, when: () => true });
    previewInfoRegistry.register("other", { id: "b", component: Component, when: () => true });
    const target: PreviewSubject = { kind: "target", target: { id: "artifact:1", title: "x.png" }, pluginId: "trace", paneId: "p" };
    expect(previewInfoRegistry.itemsFor(target).map((item) => item.id)).toEqual(["a"]);
    expect(previewInfoRegistry.itemsFor({ kind: "file", entry: file, paneId: "p" }).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("hides a section whose predicate throws", () => {
    previewInfoRegistry.register("trace", { id: "a", component: Component, when: () => { throw new Error("x"); } });
    expect(previewInfoRegistry.itemsFor({ kind: "file", entry: file, paneId: null })).toEqual([]);
  });
});

describe("pane persistence and SDK versions", () => {
  const tabWith = (layout: PersistedNode) => normalizePersistedState({ version: 3, tabs: [{ id: "t", kind: "explorer", layout, activePaneId: "p" }], activeTabId: "t" });

  it("round-trips a pane's plugin view and an explicit built-in choice", () => {
    expect(tabWith({ type: "leaf", id: "p", path: "/pictures", fileView: "trace.view" })?.tabs[0].layout).toEqual({ type: "leaf", id: "p", path: "/pictures", fileView: "trace.view" });
    expect(tabWith({ type: "leaf", id: "p", path: "/pictures", fileView: null })?.tabs[0].layout).toEqual({ type: "leaf", id: "p", path: "/pictures", fileView: null });
    expect(tabWith({ type: "leaf", id: "p", path: "/pictures" })?.tabs[0].layout).toEqual({ type: "leaf", id: "p", path: "/pictures" });
  });

  it("drops a malformed view id without losing the tab", () => {
    for (const fileView of ["<script>", "My View", 42, {}]) {
      expect(tabWith({ type: "leaf", id: "p", path: "/pictures", fileView } as unknown as PersistedNode)?.tabs[0].layout)
        .toEqual({ type: "leaf", id: "p", path: "/pictures" });
    }
  });

  it("runs SDK 1 and SDK 2 packages", () => {
    expect(SUPPORTED_SDK_VERSIONS).toEqual([1, 2]);
  });
});
