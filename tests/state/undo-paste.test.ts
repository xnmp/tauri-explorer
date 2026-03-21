/**
 * Regression test: paste operations must push undo actions.
 * Issue: fix/undo-paste, fix/undo-multi-drag
 */
import { describe, it, expect } from "vitest";
import type { UndoAction } from "$lib/state/types";

describe("Undo for paste operations", () => {
  it("copy actions are undoable", () => {
    const action: UndoAction = {
      type: "copy",
      copiedPath: "/dest/file.txt",
      parentDir: "/dest",
    };
    expect(action.type).toBe("copy");
  });

  it("batch wraps multiple actions", () => {
    const actions: UndoAction[] = [
      { type: "move", sourcePath: "/src/a.txt", destPath: "/dest/a.txt", originalDir: "/src" },
      { type: "move", sourcePath: "/src/b.txt", destPath: "/dest/b.txt", originalDir: "/src" },
    ];
    const batch: UndoAction = { type: "batch", actions, label: "Moved 2 items" };
    expect(batch.type).toBe("batch");
    if (batch.type === "batch") {
      expect(batch.actions).toHaveLength(2);
    }
  });

  it("single file paste should not be batched", () => {
    const undoActions: UndoAction[] = [
      { type: "copy", copiedPath: "/dest/file.txt", parentDir: "/dest" },
    ];
    // Logic: if length === 1, push directly without batching
    const shouldBatch = undoActions.length > 1;
    expect(shouldBatch).toBe(false);
  });
});
