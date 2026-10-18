/** Bulk file operations on large selections must stay linear: reduction,
 * per-parent publication and removal pruning each touch an entry once. */
import { afterEach, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";

vi.mock("$lib/api/files", async original => ({
  ...await original<typeof import("$lib/api/files")>(),
  deleteEntries: vi.fn(async (paths: string[]) => ({ ok: true, data: { succeeded: paths, failed: [] } })),
}));
vi.mock("$lib/api/os-clipboard", async original => ({
  ...await original<typeof import("$lib/api/os-clipboard")>(),
  osClipboardPublish: async () => ({ revision: 1 }),
  osClipboardSnapshot: async () => ({ revision: 1 }),
}));
vi.mock("$lib/state/file-events", async original => ({ ...await original<typeof import("$lib/state/file-events")>(), broadcastFileChange: vi.fn() }));

import { createPaneMutations } from "$lib/state/pane-mutations";
import { createExplorerState, type ExplorerInstance } from "$lib/state/explorer.svelte";
import type { ExplorerCoreState } from "$lib/state/types";

const folder = (path: string): FileEntry => ({ path, name: path.split("/").at(-1)!, kind: "directory", size: 0, modified: "" });
const siblings = (count: number, parent = "/r") => Array.from({ length: count }, (_, i) => folder(`${parent}/folder-${i}`));
const panes: ExplorerInstance[] = [];
afterEach(async () => { await Promise.all(panes.splice(0).map(pane => pane.destroy())); });

it("captures each parent once and reports one removal batch", async () => {
  const roots = siblings(5_000), nested = siblings(5_000, "/r/folder-0-peek");
  const coreState = { currentPath: "/r", selectedPaths: new Set<string>(), entries: roots } as unknown as ExplorerCoreState;
  const captureDirectory = vi.fn((_parent: string) => ({ publish: vi.fn() }));
  const removed = vi.fn();
  const mutations = createPaneMutations({
    coreState, setSelection: vi.fn(), alive: () => true, navigateTo: vi.fn(async () => {}), refreshSilent: vi.fn(),
    capture: () => ({ path: "/r", current: () => true, selectionCurrent: () => true }),
    captureDirectory, removed, operationEntries: () => [...roots, ...nested],
  });
  expect(await mutations.confirmDelete([...roots.slice(1), ...nested], false)).toBeNull();
  expect(captureDirectory.mock.calls.map(([parent]) => parent).sort()).toEqual(["/r", "/r/folder-0-peek"]);
  expect(removed).toHaveBeenCalledTimes(1);
  expect(removed.mock.calls[0][0]).toHaveLength(9_999);
});

it.each([["copy", 10_000], ["delete", 10_000]] as const)("%s of %i selected sibling folders finishes within a linear budget", async (action, count) => {
  const entries = siblings(count);
  const pane = createExplorerState({ currentPath: "/r", entries, sortBy: "name", sortAscending: true, viewMode: "details" });
  panes.push(pane);
  pane.selectAll();
  const started = performance.now();
  if (action === "copy") await pane.copyToClipboard(pane.getSelectedEntries());
  else expect(await pane.confirmDelete(pane.getSelectedEntries(), false)).toBeNull();
  const elapsed = performance.now() - started;
  if (action === "delete") {
    expect(pane.ownEntries).toEqual([]);
    expect(pane.selectedPaths.size).toBe(0);
  }
  // Before the linear rewrite 2,000 folders took ~5.6s (copy) and ~7.2s (delete).
  expect(elapsed).toBeLessThan(2_000);
});
