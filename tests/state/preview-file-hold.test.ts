/** The preview's file across active-pane changes (#1729). */
import { describe, expect, it } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { createPreviewFileHold, type PreviewSource } from "$lib/state/preview-file-hold";

const file = (path: string): FileEntry =>
  ({ name: path.split("/").pop()!, path, kind: "file", size: 1, modified: "today" });
const explorer = (currentPath: string, selected: FileEntry[], awaitingFirstListing = false): PreviewSource =>
  ({ currentPath, awaitingFirstListing, getSettledSelectedEntries: () => selected });

describe("preview file hold", () => {
  const a = file("/work/a.txt");

  it("follows the active pane's single selection", () => {
    const hold = createPreviewFileHold();
    const b = file("/work/b.txt");
    expect(hold.next(explorer("/work", [a]))).toBe(a);
    expect(hold.next(explorer("/work", [b]))).toBe(b);
  });

  it("keeps the file when the active pane switches to a new tab of the same folder that is still loading", () => {
    const hold = createPreviewFileHold();
    hold.next(explorer("/work", [a]));
    expect(hold.next(explorer("/work", [], true))).toBe(a);
    // Once that pane's listing selects a row, the preview follows it.
    const first = file("/work/0.txt");
    expect(hold.next(explorer("/work", [first]))).toBe(first);
  });

  it("shows the empty state when the loading pane is another folder", () => {
    const hold = createPreviewFileHold();
    hold.next(explorer("/work", [a]));
    expect(hold.next(explorer("/other", [], true))).toBeNull();
    expect(hold.next(explorer("", [], true))).toBeNull();
  });

  it("does not resurrect a file after showing nothing", () => {
    const hold = createPreviewFileHold();
    hold.next(explorer("/work", [a]));
    expect(hold.next(explorer("/work", []))).toBeNull();
    expect(hold.next(explorer("/work", [], true))).toBeNull();
  });

  it("forgets the file when no explorer is active (a Git graph tab)", () => {
    const hold = createPreviewFileHold();
    hold.next(explorer("/work", [a]));
    expect(hold.next(undefined)).toBeNull();
    expect(hold.next(explorer("/work", [], true))).toBeNull();
  });
});
