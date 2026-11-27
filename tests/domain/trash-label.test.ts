import { describe, expect, it } from "vitest";
import { trashName, trashText } from "../../src/lib/domain/trash-label";
import { extractFolderName } from "../../src/lib/domain/tab-title";
import { TRASH_PATH } from "../../src/lib/domain/virtual-path";

describe("trash label (#1919)", () => {
  it("names the location Recycle Bin on Windows and Trash elsewhere", () => {
    expect(trashName(true)).toBe("Recycle Bin");
    expect(trashName(false)).toBe("Trash");
  });

  it("rewrites messages on Windows only", () => {
    expect(trashText("Move to Trash", true)).toBe("Move to Recycle Bin");
    expect(trashText("Moved to trash", true)).toBe("Moved to Recycle Bin");
    expect(trashText("The Trash is empty", true)).toBe("The Recycle Bin is empty");
    expect(trashText("Move to Trash", false)).toBe("Move to Trash");
    expect(trashText("Moved to trash", false)).toBe("Moved to trash");
  });

  it("leaves unrelated words alone", () => {
    expect(trashText("Trashcan trashed", true)).toBe("Trashcan trashed");
  });

  it("tab title uses the platform name (non-Windows test host)", () => {
    expect(extractFolderName(TRASH_PATH)).toBe("Trash");
  });
});
