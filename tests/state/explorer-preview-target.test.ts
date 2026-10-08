/**
 * Pane-scoped plugin preview targets (SDK 2) and plugin view preference.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import type { DirectoryListingResult } from "$lib/state/directory-listing";

type LoadFn = (path: string) => Promise<DirectoryListingResult>;
const { loadImpl } = vi.hoisted(() => ({ loadImpl: { current: (async () => ({ ok: false, error: "unset" })) as LoadFn } }));
vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({ load: (path: string) => loadImpl.current(path), cleanup: async () => {} }),
}));

import { createExplorerState } from "$lib/state/explorer.svelte";
import { settingsStore } from "$lib/state/settings.svelte";

const entry = (name: string, dir = "/root"): FileEntry => ({ name, path: `${dir}/${name}`, kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" });
const target = { id: "artifact:7", title: "edit.png" };

beforeEach(() => {
  localStorage.clear();
  settingsStore.reset();
  const listings: Record<string, FileEntry[]> = { "/root": [entry("a.png"), entry("b.png")], "/other": [entry("c.png", "/other")] };
  loadImpl.current = async (path) => listings[path] ? { ok: true, path, entries: listings[path] } : { ok: false, error: "missing" };
});

describe("preview targets", () => {
  it("replaces the file selection and yields to a later file selection", async () => {
    const explorer = createExplorerState();
    await explorer.navigateTo("/root");
    explorer.setPreviewTarget("trace", target);
    expect(explorer.selectedPaths.size).toBe(0);
    expect(explorer.previewTarget).toEqual({ owner: "trace", target, directory: "/root" });
    explorer.selectPaths(["/root/b.png"]);
    expect(explorer.previewTarget).toBeNull();
  });

  it("belongs to the folder it was set in", async () => {
    const explorer = createExplorerState();
    await explorer.navigateTo("/root");
    explorer.setPreviewTarget("trace", target);
    await explorer.navigateTo("/other");
    expect(explorer.previewTarget).toBeNull();
  });

  it("is cleared only by its owner", async () => {
    const explorer = createExplorerState();
    await explorer.navigateTo("/root");
    explorer.setPreviewTarget("trace", target);
    explorer.setPreviewTarget("other", null);
    explorer.clearPreviewTargetsOwnedBy("other");
    expect(explorer.previewTarget?.owner).toBe("trace");
    explorer.clearPreviewTargetsOwnedBy("trace");
    expect(explorer.previewTarget).toBeNull();
  });
});

describe("selection with a primary focus", () => {
  it("selects listed paths, ignores unknown ones and sets the primary entry", async () => {
    const explorer = createExplorerState();
    await explorer.navigateTo("/root");
    explorer.selectPaths(["/root/a.png", "/root/b.png", "/elsewhere/x.png"], "/root/a.png");
    expect([...explorer.selectedPaths].sort()).toEqual(["/root/a.png", "/root/b.png"]);
    expect(explorer.state.cursorPath).toBe("/root/a.png");
    expect(explorer.state.selectionAnchorPath).toBe("/root/a.png");
  });
});

describe("plugin view preference", () => {
  it("keeps the built-in view mode while a plugin view is chosen", () => {
    const explorer = createExplorerState();
    explorer.setViewMode("tiles");
    explorer.setFileView("trace.view");
    expect(explorer.viewMode).toBe("tiles");
    explorer.setFileView(null);
    expect(explorer.viewMode).toBe("tiles");
  });

  it("keeps an explicit built-in choice when a default plugin view is set", () => {
    settingsStore.setDefaultFileView("trace.view");
    const explorer = createExplorerState();
    expect(explorer.fileView).toBe("trace.view");
    expect(explorer.fileViewChoice).toBeUndefined();
    explorer.setFileView(null);
    expect(explorer.fileView).toBeNull();
    expect(explorer.fileViewChoice).toBeNull();
  });

  it("treats a malformed view id as the built-in view", () => {
    const explorer = createExplorerState();
    explorer.setFileView("not a view id");
    expect(explorer.fileView).toBeNull();
  });

  it("ignores a malformed default view setting", () => {
    settingsStore.setDefaultFileView("My View");
    expect(settingsStore.defaultFileView).toBe("");
    expect(createExplorerState().fileView).toBeNull();
  });

  it("clears a Preview target when the pane changes view", async () => {
    const explorer = createExplorerState();
    await explorer.initialLoad("/root");
    explorer.setFileView("trace.view");
    explorer.setPreviewTarget("trace", target);
    expect(explorer.previewTarget?.target.id).toBe("artifact:7");
    explorer.setFileView(null);
    expect(explorer.previewTarget).toBeNull();
  });

  it("seeds new panes from the default plugin view setting", () => {
    settingsStore.setDefaultFileView("trace.view");
    expect(createExplorerState().fileView).toBe("trace.view");
    settingsStore.setDefaultFileView(null);
    expect(createExplorerState().fileView).toBeNull();
  });
});
