/** In-app rename and move carry "Date opened"; delete and trash drop it (#1525). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";

const api = vi.hoisted(() => ({ renameEntry: vi.fn(), deleteEntries: vi.fn(), moveEntries: vi.fn() }));
vi.mock("$lib/api/files", async (original) => ({ ...await original<typeof import("$lib/api/files")>(), renameEntry: api.renameEntry, deleteEntries: api.deleteEntries }));
vi.mock("$lib/api/move-session", () => ({ moveEntries: api.moveEntries }));
vi.mock("$lib/api/open-history", () => ({ readOpenHistory: async () => ({ ok: true, data: "" }), writeOpenHistory: async () => ({ ok: true, data: undefined }) }));
vi.mock("$lib/state/file-events", async (original) => ({ ...await original<typeof import("$lib/state/file-events")>(), broadcastFileChange: vi.fn() }));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: { show: vi.fn(), error: vi.fn(), broadcast: vi.fn() } }));

import { createPaneMutations } from "$lib/state/pane-mutations";
import { moveFiles } from "$lib/state/move-operations";
import { openHistoryStore } from "$lib/state/open-history.svelte";
import { openHistory } from "$lib/state/open-history-access.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import type { ExplorerCoreState } from "$lib/state/types";

const file = (path: string): FileEntry => ({ path, name: path.split("/").at(-1)!, kind: "file", size: 1, modified: "" });

function mutations() {
  const coreState = { currentPath: "/d", selectedPaths: new Set<string>(), entries: [file("/d/a.txt")] } as unknown as ExplorerCoreState;
  return createPaneMutations({
    coreState, setSelection: vi.fn(), alive: () => true, navigateTo: vi.fn(async () => {}), refreshSilent: vi.fn(),
    capture: () => ({ path: "/d", current: () => true, selectionCurrent: () => true }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  openHistoryStore.forget(["/d", "/e"]);
  openHistoryStore.record("/d/a.txt", 1_000);
});

describe("open history follows in-app mutations", () => {
  it("rename carries the timestamp to the new path", async () => {
    api.renameEntry.mockResolvedValue({ ok: true, data: { path: "/d/b.txt", entry: file("/d/b.txt") } });
    dialogStore.startRename(file("/d/a.txt"));
    expect(await mutations().rename("b.txt")).toBeNull();
    await openHistory();
    expect(openHistoryStore.lastOpened("/d/b.txt")).toBe(1_000);
    expect(openHistoryStore.lastOpened("/d/a.txt")).toBeUndefined();
  });

  it("a failed rename keeps the timestamp where it was", async () => {
    api.renameEntry.mockResolvedValue({ ok: false, error: "denied" });
    dialogStore.startRename(file("/d/a.txt"));
    expect(await mutations().rename("b.txt")).toBe("denied");
    expect(openHistoryStore.lastOpened("/d/a.txt")).toBe(1_000);
  });

  it("move carries timestamps only for items that arrived", async () => {
    openHistoryStore.record("/d/c.txt", 2_000);
    api.moveEntries.mockResolvedValue({ ok: true, data: { cancelled: false, warnings: [], items: [
      { status: "succeeded", receipt: { path: "/e/a.txt", entry: file("/e/a.txt") } },
      { status: "failed", error: "busy" },
    ] } });
    await moveFiles(["/d/a.txt", "/d/c.txt"], "/e", { onRefresh: vi.fn() });
    await openHistory();
    expect(openHistoryStore.lastOpened("/e/a.txt")).toBe(1_000);
    expect(openHistoryStore.lastOpened("/d/a.txt")).toBeUndefined();
    expect(openHistoryStore.lastOpened("/d/c.txt")).toBe(2_000);
  });

  it.each([["trash", false], ["permanent delete", true]] as const)("%s drops the timestamp", async (_label, permanent) => {
    api.deleteEntries.mockResolvedValue({ ok: true, data: { succeeded: ["/d/a.txt"], failed: [] } });
    expect(await mutations().confirmDelete([file("/d/a.txt")], permanent)).toBeNull();
    await openHistory();
    expect(openHistoryStore.lastOpened("/d/a.txt")).toBeUndefined();
  });
});
