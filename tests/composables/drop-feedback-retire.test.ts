import { describe, expect, it, vi } from "vitest";
vi.mock("$lib/state/drag.svelte", () => ({ dragState: { acceptsFileDrag: () => true, acceptsFileDrop: () => true } }));
import { retireDropFeedback, useBackgroundDropFeedback, useDropTarget } from "$lib/composables/use-drop-target.svelte";
import type { FileEntry } from "$lib/domain/file";

// Folder drop feedback belongs to one gesture (#1242 review): a drop, a drag
// end or leaving the window retires it everywhere, including feedback whose
// surface unmounted (a closing spring peek) before any leave could reach it.
const folder = (path: string): FileEntry => ({ path, name: path.split("/").at(-1)!, kind: "directory", size: 0, modified: "" });
const over = (copy = false) => ({
  preventDefault: () => {}, ctrlKey: copy, metaKey: copy, altKey: false, shiftKey: false,
  dataTransfer: { dropEffect: "none" },
}) as unknown as DragEvent;

describe("drop feedback lifetime", () => {
  it("a retired gesture's feedback reads as gone, and the next gesture starts clean", () => {
    const targets = useDropTarget({ onRefresh: () => {} });
    const others = useDropTarget({ onRefresh: () => {} });
    targets.handleDragOver(over(true), folder("/r/Inbox"));
    others.handleDragOver(over(), folder("/r/Archive"));
    expect(targets.isDropTarget("/r/Inbox")).toBe(true);
    expect(targets.isCopyDrop("/r/Inbox")).toBe(true);
    expect(others.isDropTarget("/r/Archive")).toBe(true);

    retireDropFeedback();
    expect(targets.isDropTarget("/r/Inbox")).toBe(false);
    expect(targets.isCopyDrop("/r/Inbox")).toBe(false);
    expect(others.isDropTarget("/r/Archive")).toBe(false);

    // The next drag over another folder does not revive the old one.
    targets.handleDragOver(over(), folder("/r/Empty"));
    expect(targets.isDropTarget("/r/Empty")).toBe(true);
    expect(targets.isDropTarget("/r/Inbox")).toBe(false);
    expect(targets.isCopyDrop("/r/Empty")).toBe(false);
  });

  it("a file entry never shows folder feedback", () => {
    const targets = useDropTarget({ onRefresh: () => {} });
    targets.handleDragOver(over(), { ...folder("/r/a.txt"), kind: "file" });
    expect(targets.isDropTarget("/r/a.txt")).toBe(false);
  });

  it("the listing background's highlight is retired with the gesture, though no leave or drop reached it (#1269)", () => {
    const background = useBackgroundDropFeedback();
    background.set(true);
    expect(background.active).toBe(true);
    retireDropFeedback();
    expect(background.active).toBe(false);
    // The next gesture highlights it again.
    background.set(true);
    expect(background.active).toBe(true);
    background.set(false);
    expect(background.active).toBe(false);
  });
});
