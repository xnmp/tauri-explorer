/**
 * A drag can be released right after crossing into a folder row's child
 * (icon, name): WebKit then has seen dragenter for the new element but no
 * dragover yet, and only delivers `drop` if that dragenter was accepted.
 * Folder rows must therefore accept file drags on dragenter as well.
 */
import { describe, it, expect } from "vitest";

import { useDropTarget } from "$lib/composables/use-drop-target.svelte";
import type { FileEntry } from "$lib/domain/file";

const folder = { path: "/home/user/Docs", kind: "directory", name: "Docs" } as unknown as FileEntry;
const file = { path: "/home/user/a.txt", kind: "file", name: "a.txt" } as unknown as FileEntry;

function dragEvent(types: string[], ctrlKey = false) {
  const event = {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    dataTransfer: { types, dropEffect: "none" },
    ctrlKey, metaKey: false, altKey: false,
  };
  return event as unknown as DragEvent & { defaultPrevented: boolean };
}

describe("drop target accepts a drag on dragenter", () => {
  it("accepts an explorer file drag entering a folder row and highlights it", () => {
    const target = useDropTarget({ onRefresh: () => {} });
    const event = dragEvent(["application/x-explorer-path"]);
    target.handleDragEnter(event, folder);
    expect(event.defaultPrevented).toBe(true);
    expect(event.dataTransfer!.dropEffect).toBe("move");
    expect(target.isDropTarget(folder.path)).toBe(true);
  });

  it("reports copy while the copy modifier is held", () => {
    const target = useDropTarget({ onRefresh: () => {} });
    const event = dragEvent(["application/x-explorer-path"], true);
    target.handleDragEnter(event, folder);
    expect(event.dataTransfer!.dropEffect).toBe("copy");
  });

  it("does not accept a file row or a foreign drag", () => {
    const target = useDropTarget({ onRefresh: () => {} });
    const onFile = dragEvent(["application/x-explorer-path"]);
    target.handleDragEnter(onFile, file);
    expect(onFile.defaultPrevented).toBe(false);
    const foreign = dragEvent(["text/plain"]);
    target.handleDragEnter(foreign, folder);
    expect(foreign.defaultPrevented).toBe(false);
  });
});
