import { describe, expect, it } from "vitest";
import {
  TRASH_PATH, isTrashPath, isTrashRoot, originalFolder, restoreSummary, toTrashListing,
  trashIssuesMessage, type TrashWireEntry,
} from "$lib/domain/trash";

function wire(overrides: Partial<TrashWireEntry> = {}): TrashWireEntry {
  return {
    id: "a1", name: "report.txt", originalPath: "/home/user/docs/report.txt",
    deletedAt: "2026-01-02T03:04:05+00:00", kind: "file", size: 42, isSymlink: false,
    ...overrides,
  };
}

describe("trash location paths", () => {
  it("accepts both root spellings and rejects other schemes", () => {
    expect(isTrashRoot("trash://")).toBe(true);
    expect(isTrashRoot("trash:///")).toBe(true);
    expect(isTrashRoot("trash://a1")).toBe(false);
    expect(isTrashPath("trash://a1")).toBe(true);
    expect(isTrashPath("/home/user/trash")).toBe(false);
    expect(isTrashRoot("demo://")).toBe(false);
    expect(isTrashPath("trash://")).toBe(true);
  });
});

describe("toTrashListing", () => {
  it("gives same-named items distinct paths and keeps their origin and deletion time", () => {
    const listing = toTrashListing({
      entries: [wire(), wire({ id: "b2", originalPath: "/srv/report.txt", deletedAt: null })],
      issues: [],
    });
    expect(listing.path).toBe(TRASH_PATH);
    expect(listing.entries.map((entry) => entry.path)).toEqual(["trash://a1", "trash://b2"]);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["report.txt", "report.txt"]);
    expect(listing.entries[0]).toMatchObject({
      kind: "file", size: 42, modified: "2026-01-02T03:04:05+00:00",
      trash: { id: "a1", originalPath: "/home/user/docs/report.txt", deletedAt: "2026-01-02T03:04:05+00:00", originalFolder: "/home/user/docs" },
    });
    expect(listing.entries[1].modified).toBe("");
  });
});

describe("originalFolder", () => {
  it.each([
    ["/home/user/docs/report.txt", "/home/user/docs"],
    ["/report.txt", "/"],
    ["C:\\Users\\me\\report.txt", "C:\\Users\\me"],
    ["C:\\report.txt", "C:\\"],
  ])("%s came from %s", (originalPath, folder) => {
    const [entry] = toTrashListing({ entries: [wire({ originalPath })], issues: [] }).entries;
    expect(entry.trash?.originalFolder).toBe(folder);
    expect(originalFolder(originalPath)).toBe(folder);
  });

  it("is unknown when the platform recorded no origin", () => {
    const [entry] = toTrashListing({ entries: [wire({ originalPath: null })], issues: [] }).entries;
    expect(entry.trash?.originalFolder).toBeNull();
  });
});

describe("trashIssuesMessage", () => {
  it("names each unreadable source", () => {
    expect(trashIssuesMessage([])).toBeNull();
    expect(trashIssuesMessage([{ source: "/mnt/usb/.Trash-1000", error: "Permission denied" }]))
      .toBe("Some trash items could not be shown. /mnt/usb/.Trash-1000: Permission denied");
    expect(trashIssuesMessage([{ source: "a", error: "x" }, { source: "b", error: "y" }]))
      .toContain("2 trash locations could not be fully read");
  });
});

describe("restoreSummary", () => {
  const entries = toTrashListing({
    entries: [wire(), wire({ id: "b2", name: "notes.txt", originalPath: "/srv/notes.txt" })],
    issues: [],
  }).entries;

  it("reports a single restore with its destination", () => {
    expect(restoreSummary({ succeeded: ["/home/user/docs/report.txt"], failed: [] }, entries)).toEqual({
      restored: ["/home/user/docs/report.txt"],
      message: "Restored report.txt to /home/user/docs/report.txt",
      failed: false,
    });
  });

  it("names every refused item and why, beside what was restored", () => {
    const summary = restoreSummary({
      succeeded: ["/home/user/docs/report.txt"],
      failed: [{ path: "/srv/notes.txt", error: "/srv/notes.txt already exists. Rename or move it, then restore again." }],
    }, entries);
    expect(summary.failed).toBe(true);
    expect(summary.message).toBe(
      "Restored report.txt to /home/user/docs/report.txt. Could not restore 1 item: notes.txt: /srv/notes.txt already exists. Rename or move it, then restore again.",
    );
  });
});

describe("Trash tab titles", () => {
  it("names the Trash tab instead of showing its scheme", async () => {
    const { disambiguateTabTitles, extractFolderName } = await import("$lib/domain/tab-title");
    expect(extractFolderName("trash://")).toBe("Trash");
    expect(disambiguateTabTitles([{ id: "t", path: "trash://" }, { id: "d", path: "/home/user/Documents" }]))
      .toEqual(new Map([["t", "Trash"], ["d", "Documents"]]));
  });
});
