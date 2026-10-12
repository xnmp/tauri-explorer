import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import type { Job } from "$lib/state/jobs.svelte";
import type { JobReveal } from "$lib/plugins/api";

const fixture = vi.hoisted(() => ({
  explorer: undefined as ExplorerInstance | undefined,
  load: vi.fn<(path: string) => Promise<DirectoryListingResult>>(),
  mountView: vi.fn(),
}));
vi.mock("$lib/state/directory-listing", () => ({
  createDirectoryListing: () => ({ load: fixture.load, cleanup: async () => {} }),
}));
vi.mock("$lib/state/window-tabs.svelte", () => ({
  windowTabsManager: {
    get tabs() { return [{ id: "tab", kind: "explorer", panes: { pane: { path: fixture.explorer?.currentPath } } }]; },
    activePaneId: "pane", getActiveExplorer: () => fixture.explorer, getExplorer: () => fixture.explorer,
    setActiveTab: () => {}, setActivePane: () => {}, setPaneGitGraph: () => {},
    setPaneFileView: fixture.mountView,
  },
}));

import { createExplorerState } from "$lib/state/explorer.svelte";
import { jobRevealController } from "$lib/state/job-reveal";
import { settingsStore } from "$lib/state/settings.svelte";
import { toastStore } from "$lib/state/toast.svelte";

const job = (reveal: JobReveal): Job => ({ id: 1, label: "Image", detail: "", source: "fixture", status: "completed", startTime: 0, reveal });

const entries = ["first.png", "out.png", "saved\\draft.png"].map(name => ({
  name, path: `/images/${name}`, kind: "file" as const, size: 1, modified: "2026-01-01T00:00:00Z",
}));
beforeEach(() => {
  settingsStore.reset(); toastStore.clear(); fixture.mountView.mockClear();
  fixture.load.mockReset().mockImplementation(async path => path === "/images"
    ? { ok: true, path, entries } : { ok: false, error: `No such directory: ${path}` });
  fixture.explorer = createExplorerState();
});
afterEach(async () => { jobRevealController.abort(); await fixture.explorer?.destroy(); });

it("reloads an errored matching pane before revealing the saved image", async () => {
  const explorer = fixture.explorer!;
  await explorer.navigateTo("/images"); await explorer.navigateTo("/deleted");
  expect(explorer.currentPath).toBe("/images"); expect(explorer.error).toBe("No such directory: /deleted");
  await jobRevealController.show(job({ kind: "file", path: "/images/out.png" }));
  expect(explorer.error).toBeNull();
  expect([...explorer.selectedPaths]).toEqual(["/images/out.png"]);
});

it.each<JobReveal>([
  { kind: "file", path: "/images/out.png" },
  { kind: "view", viewId: "trace.view", directory: "/images", targetId: "42" },
])("requires a successful reload before selecting or mounting $kind", async reveal => {
  const explorer = fixture.explorer!;
  await explorer.navigateTo("/images"); await explorer.navigateTo("/deleted");
  fixture.load.mockResolvedValue({ ok: false, error: "Images folder is gone" });
  await jobRevealController.show(job(reveal));
  expect(explorer.error).toBe("Images folder is gone");
  expect([...explorer.selectedPaths]).toEqual(["/images/first.png"]);
  expect(fixture.mountView).not.toHaveBeenCalled();
});

it("reveals a POSIX filename containing a literal backslash", async () => {
  const explorer = fixture.explorer!; await explorer.navigateTo("/images");
  await jobRevealController.show(job({ kind: "file", path: "/images/saved\\draft.png" }));
  expect(explorer.error).toBeNull(); expect(explorer.currentPath).toBe("/images");
  expect([...explorer.selectedPaths]).toEqual(["/images/saved\\draft.png"]);
});


it("navigates to an image folder containing a literal POSIX backslash", async () => {
  const explorer = fixture.explorer!; await explorer.navigateTo("/images");
  const directory = "/images\\draft";
  const path = `${directory}/out.png`;
  fixture.load.mockImplementation(async requested => requested === directory
    ? { ok: true, path: directory, entries: [{ ...entries[1], path }] }
    : { ok: false, error: `No such directory: ${requested}` });
  await jobRevealController.show(job({ kind: "file", path }));
  expect(explorer.error).toBeNull(); expect(explorer.currentPath).toBe(directory);
  expect([...explorer.selectedPaths]).toEqual([path]);
});
