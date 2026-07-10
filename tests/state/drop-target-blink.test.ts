/**
 * Drop-target highlight stability (#242).
 *
 * dragenter/dragleave pair per ELEMENT, not per subtree: moving the cursor
 * onto a child of a folder row fires dragleave on the row while the drag is
 * still visually over the folder. The highlight must survive those internal
 * leaves (blink) and clear only on a genuine exit.
 */
import { describe, it, expect } from "vitest";

import { useDropTarget } from "$lib/composables/use-drop-target.svelte";
import type { FileEntry } from "$lib/domain/file";

const folder = { path: "/home/user/Docs", kind: "directory", name: "Docs" } as unknown as FileEntry;

const rowRect = { left: 100, top: 100, right: 400, bottom: 132, width: 300, height: 32, x: 100, y: 100, toJSON: () => ({}) };

function makeRow(children: Node[] = []): HTMLElement {
  return {
    contains: (node: Node | null) => (node ? children.includes(node) : false),
    getBoundingClientRect: () => rowRect,
  } as unknown as HTMLElement;
}

function dragOver(target: ReturnType<typeof useDropTarget>): void {
  target.handleDragOver(
    {
      preventDefault: () => {},
      dataTransfer: { types: ["application/x-explorer-path"], dropEffect: "none" },
      ctrlKey: false,
      metaKey: false,
      altKey: false,
    } as unknown as DragEvent,
    folder,
  );
}

function dragLeave(
  target: ReturnType<typeof useDropTarget>,
  row: HTMLElement,
  opts: { relatedTarget?: Node | null; clientX: number; clientY: number },
): void {
  target.handleDragLeave(
    {
      currentTarget: row,
      relatedTarget: opts.relatedTarget ?? null,
      clientX: opts.clientX,
      clientY: opts.clientY,
    } as unknown as DragEvent,
    folder,
  );
}

describe("drop-target highlight stability (#242)", () => {
  it("keeps the highlight when dragleave targets a child of the row", () => {
    const child = {} as Node;
    const row = makeRow([child]);
    const target = useDropTarget({ onRefresh: () => {} });

    dragOver(target);
    expect(target.isDropTarget(folder.path)).toBe(true);

    dragLeave(target, row, { relatedTarget: child, clientX: 200, clientY: 110 });
    expect(target.isDropTarget(folder.path)).toBe(true);
  });

  it("keeps the highlight when relatedTarget is null but coords stay inside the row (WebKit)", () => {
    const row = makeRow();
    const target = useDropTarget({ onRefresh: () => {} });

    dragOver(target);
    dragLeave(target, row, { relatedTarget: null, clientX: 250, clientY: 120 });
    expect(target.isDropTarget(folder.path)).toBe(true);
  });

  it("clears the highlight on a genuine exit (coords outside the row)", () => {
    const row = makeRow();
    const target = useDropTarget({ onRefresh: () => {} });

    dragOver(target);
    dragLeave(target, row, { relatedTarget: null, clientX: 250, clientY: 150 });
    expect(target.isDropTarget(folder.path)).toBe(false);
  });

  it("clears the highlight when relatedTarget is outside the row", () => {
    const row = makeRow();
    const target = useDropTarget({ onRefresh: () => {} });

    dragOver(target);
    dragLeave(target, row, { relatedTarget: {} as Node, clientX: 200, clientY: 110 });
    expect(target.isDropTarget(folder.path)).toBe(false);
  });

  it("clears the highlight on a window-exit dragleave (0,0 coords, null relatedTarget)", () => {
    const row = makeRow();
    const target = useDropTarget({ onRefresh: () => {} });

    dragOver(target);
    dragLeave(target, row, { relatedTarget: null, clientX: 0, clientY: 0 });
    expect(target.isDropTarget(folder.path)).toBe(false);
  });
});
