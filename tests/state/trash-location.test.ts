import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectoryListingResult } from "$lib/state/directory-listing";
import type { TrashPorts } from "$lib/state/trash-location";
import type { TrashWireListing } from "$lib/domain/trash";
import type { FileEntry } from "$lib/domain/file";

const mocks = vi.hoisted(() => ({
  listTrash: vi.fn(),
  restoreTrashItems: vi.fn(),
  deleteTrashItems: vi.fn(),
}));

vi.mock("$lib/api/trash", () => ({
  listTrash: mocks.listTrash,
  restoreTrashItems: mocks.restoreTrashItems,
  deleteTrashItems: mocks.deleteTrashItems,
}));

import { installTrashActions, listTrashLocation, restoreFromTrash } from "$lib/state/trash-location";
import { installTrashLocation } from "$lib/state/trash-provider";
import { createExplorerState, type ExplorerInstance } from "$lib/state/explorer.svelte";
import { registerFsProvider, clearFsProviders } from "$lib/plugins/fs-providers";
import { broadcastFileChange } from "$lib/state/file-events";
import { TRASH_PATH, toTrashListing } from "$lib/domain/trash";

const LISTING: TrashWireListing = {
  entries: [
    { id: "a1", name: "report.txt", originalPath: "/docs/report.txt", deletedAt: "2026-01-02T03:04:05Z", kind: "file", size: 5, isSymlink: false },
    { id: "b2", name: "report.txt", originalPath: "/srv/report.txt", deletedAt: "2026-01-03T03:04:05Z", kind: "file", size: 7, isSymlink: false },
  ],
  issues: [],
};

function ports(overrides: Partial<TrashPorts> = {}): TrashPorts & Record<"success" | "error" | "publish", ReturnType<typeof vi.fn>> {
  return {
    list: vi.fn(async () => ({ ok: true as const, data: LISTING })),
    restore: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    publish: vi.fn(),
    ...overrides,
  } as never;
}

const explorers: ExplorerInstance[] = [];
let uninstall: (() => void) | undefined;

afterEach(async () => {
  uninstall?.();
  uninstall = undefined;
  clearFsProviders();
  await Promise.all(explorers.splice(0).map((explorer) => explorer.destroy()));
  mocks.listTrash.mockReset();
  mocks.restoreTrashItems.mockReset();
  vi.restoreAllMocks();
});

describe("listTrashLocation", () => {
  it("lists the trash root as ordinary explorer entries", async () => {
    const listing = await listTrashLocation("trash:///", ports());
    expect(listing.path).toBe(TRASH_PATH);
    expect(listing.entries.map((entry) => [entry.path, entry.name, entry.trash?.originalPath])).toEqual([
      ["trash://a1", "report.txt", "/docs/report.txt"],
      ["trash://b2", "report.txt", "/srv/report.txt"],
    ]);
  });

  it("turns an unreadable trash into an in-app error instead of an empty view", async () => {
    await expect(listTrashLocation(TRASH_PATH, ports({ list: async () => ({ ok: false, error: "Permission denied" }) })))
      .rejects.toThrow("Could not read the Trash: Permission denied");
  });

  it("keeps readable entries and reports each distinct source issue once", async () => {
    const withIssue = ports({
      list: async () => ({ ok: true, data: { ...LISTING, issues: [{ source: "/mnt/usb/.Trash-1000", error: "Permission denied" }] } }),
    });
    expect((await listTrashLocation(TRASH_PATH, withIssue)).entries).toHaveLength(2);
    await listTrashLocation(TRASH_PATH, withIssue);
    expect(withIssue.error).toHaveBeenCalledExactlyOnceWith(
      "Some trash items could not be shown. /mnt/usb/.Trash-1000: Permission denied",
    );
  });

  it("reports a persisting source issue again when the Trash is reopened later", async () => {
    let now = 1_000_000;
    const issue = { source: "/mnt/nas/.Trash-1000", error: "This volume did not respond in time, so its trash is not shown" };
    const port = ports({
      list: async () => ({ ok: true, data: { ...LISTING, issues: [issue] } }),
      now: () => now,
    });
    await listTrashLocation(TRASH_PATH, port);
    now += 5_000;
    await listTrashLocation(TRASH_PATH, port);
    expect(port.error).toHaveBeenCalledTimes(1);
    now += 60_000;
    await listTrashLocation(TRASH_PATH, port);
    expect(port.error).toHaveBeenCalledTimes(2);
  });

  it("refuses to open a trashed folder in place", async () => {
    await expect(listTrashLocation("trash://a1", ports())).rejects.toThrow("Restore this folder");
  });
});

describe("restoreFromTrash", () => {
  const entries = toTrashListing(LISTING).entries;

  it("restores by native ID and refreshes the Trash and both destinations", async () => {
    const restore = vi.fn(async () => ({ ok: true as const, data: { succeeded: ["/docs/report.txt", "/srv/report.txt"], failed: [] } }));
    const port = ports({ restore });
    await restoreFromTrash(entries, port);
    expect(restore).toHaveBeenCalledExactlyOnceWith(["a1", "b2"]);
    expect(port.publish).toHaveBeenCalledExactlyOnceWith(["/docs", "/srv"]);
    expect(port.success).toHaveBeenCalledExactlyOnceWith("Restored 2 items");
    expect(port.error).not.toHaveBeenCalled();
  });

  it("reports a refused collision as an actionable error", async () => {
    const port = ports({
      restore: async () => ({ ok: true, data: { succeeded: [], failed: [{ path: "/docs/report.txt", error: "/docs/report.txt already exists. Rename or move it, then restore again." }] } }),
    });
    const summary = await restoreFromTrash([entries[0]], port);
    expect(summary?.failed).toBe(true);
    expect(port.error).toHaveBeenCalledExactlyOnceWith(
      "Could not restore 1 item: report.txt: /docs/report.txt already exists. Rename or move it, then restore again.",
    );
    expect(port.success).not.toHaveBeenCalled();
  });

  it("ignores entries that are not in the Trash", async () => {
    const port = ports();
    expect(await restoreFromTrash([{ name: "a", path: "/a", kind: "file", size: 0, modified: "" }], port)).toBeNull();
    expect(port.restore).not.toHaveBeenCalled();
  });
});

describe("Trash as an explorer location", () => {
  function explorerAt(path: string): ExplorerInstance {
    const explorer = createExplorerState({ currentPath: path, entries: [], sortBy: "name", sortAscending: true, viewMode: "details" });
    explorers.push(explorer);
    return explorer;
  }

  it("navigates in the pane and participates in back/forward history", async () => {
    mocks.listTrash.mockResolvedValue({ ok: true, data: LISTING });
    uninstall = installTrashLocation();
    registerFsProvider("demo", { list: (path) => ({ path, entries: [] }) });
    const explorer = explorerAt("demo://");

    expect(await explorer.navigateTo("trash:///", { autoEnterSingleSubdir: false })).toBe(true);
    expect(explorer.currentPath).toBe(TRASH_PATH);
    expect(explorer.displayEntries.map((entry) => entry.trash?.id)).toEqual(["a1", "b2"]);

    expect(await explorer.navigateTo("demo://elsewhere", { autoEnterSingleSubdir: false })).toBe(true);
    await explorer.goBack();
    expect(explorer.currentPath).toBe(TRASH_PATH);
    await explorer.goForward();
    expect(explorer.currentPath).toBe("demo://elsewhere");
  });

  it("offers Restore for trashed selections and the system launcher only in the Trash", async () => {
    const { contextMenuItems } = await import("$lib/state/context-menu-items.svelte");
    installTrashActions(contextMenuItems);
    const entries = toTrashListing(LISTING).entries;
    const trashOnly = (selection: FileEntry[]) => contextMenuItems.itemsFor(selection)
      .filter((item) => item.scope === "trash").map((item) => item.label);
    expect(trashOnly([...entries])).toEqual(["Restore", "Permanently Delete…"]);
    const unrecorded = { ...entries[0], trash: { ...entries[0].trash!, originalPath: null, originalFolder: null } };
    expect(trashOnly([unrecorded])).toEqual(["Permanently Delete…"]);
    expect(trashOnly([entries[0], unrecorded])).toEqual(["Permanently Delete…"]);
    expect(trashOnly([])).toEqual(["Open in System File Manager"]);
    expect(trashOnly([{ name: "a", path: "/a", kind: "file", size: 0, modified: "" }])).toEqual([]);

    mocks.restoreTrashItems.mockResolvedValue({ ok: true, data: { succeeded: ["/docs/report.txt"], failed: [] } });
    const restore = contextMenuItems.itemsFor([entries[0]]).find((item) => item.id === "trash.restore")!;
    await restore.handler([entries[0]]);
    await vi.waitFor(() => expect(mocks.restoreTrashItems).toHaveBeenCalledExactlyOnceWith(["a1"]));
  });

  it("refreshes an open Trash view when this window publishes a trash change", async () => {
    mocks.listTrash.mockResolvedValue({ ok: true, data: LISTING });
    uninstall = installTrashLocation();
    const explorer = explorerAt("demo://");
    registerFsProvider("demo", { list: (path) => ({ path, entries: [] }) });
    const { windowTabsManager } = await import("$lib/state/window-tabs.svelte");
    vi.spyOn(windowTabsManager, "getAllExplorers").mockReturnValue([explorer]);
    await explorer.navigateTo(TRASH_PATH, { autoEnterSingleSubdir: false });
    mocks.listTrash.mockResolvedValue({ ok: true, data: { entries: [LISTING.entries[1]], issues: [] } });

    broadcastFileChange(["/docs", TRASH_PATH]);
    await vi.waitFor(() => expect(explorer.displayEntries.map((entry) => entry.trash?.id)).toEqual(["b2"]));
  });
});

export type { DirectoryListingResult };


describe("Trash deletion (#1216)", () => {
  it("deletes by opaque ID and maps mixed outcomes back to pane entries", async () => {
    const { deleteFromTrash } = await import("$lib/state/trash-location");
    mocks.deleteTrashItems.mockResolvedValue({ ok: true, data: { succeeded: ["a1"], failed: [{ path: "b2", error: "item changed" }], unstarted: [], uncertain: [] } });
    const entries = toTrashListing(LISTING).entries;
    expect(await deleteFromTrash(entries)).toEqual({ ok: true, data: { succeeded: ["trash://a1"], failed: [{ path: "trash://b2", error: "item changed" }], unstarted: [], uncertain: [] } });
    expect(mocks.deleteTrashItems).toHaveBeenCalledExactlyOnceWith(["a1", "b2"]);
  });
});
