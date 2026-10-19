import { describe, expect, it } from "vitest";
import { caretlessDoubleClickNotice, rowClickOwnsPeek, shouldToggleOnRowClick, type RowClickInput } from "$lib/domain/folder-peek";

const plain: RowClickInput = {
  caretsShown: false, isDirectory: true, eligible: true,
  modifiers: { ctrlKey: false, shiftKey: false, metaKey: false, altKey: false }, wasDrag: false,
};
const decide = (patch: Partial<RowClickInput> = {}, modifiers: Partial<RowClickInput["modifiers"]> = {}) =>
  shouldToggleOnRowClick({ ...plain, ...patch, modifiers: { ...plain.modifiers, ...modifiers } });

describe("shouldToggleOnRowClick", () => {
  it("a plain click on an eligible folder row with carets hidden toggles", () => {
    expect(decide()).toBe(true);
  });
  it.each(["ctrlKey", "shiftKey", "metaKey", "altKey"] as const)("%s turns the click into selection only", key => {
    expect(decide({}, { [key]: true })).toBe(false);
  });
  it("never toggles a file row", () => {
    expect(decide({ isDirectory: false })).toBe(false);
  });
  it("never toggles an ineligible (virtual, provider or peek-off) location", () => {
    expect(decide({ eligible: false })).toBe(false);
  });
  it("leaves toggling to the caret while carets are shown", () => {
    expect(decide({ caretsShown: true })).toBe(false);
  });
  it("a click that ends a drag does not toggle", () => {
    expect(decide({ wasDrag: true })).toBe(false);
  });
});

describe("rowClickOwnsPeek (a refused folder double-click, #1298)", () => {
  const target = { caretsShown: false, isDirectory: true, eligible: true };
  it("owns an eligible folder while carets are hidden, whatever toggles the clicks would make", () => {
    expect(rowClickOwnsPeek(target)).toBe(true);
    // Modifiers or a drag end only stop the clicks toggling; navigation stays refused.
    const ctrlDrag: RowClickInput = { ...plain, wasDrag: true, modifiers: { ...plain.modifiers, ctrlKey: true } };
    expect(rowClickOwnsPeek(ctrlDrag)).toBe(true);
  });
  it.each([
    ["carets shown", { caretsShown: true }],
    ["a file row", { isDirectory: false }],
    ["an ineligible location", { eligible: false }],
  ])("leaves double-click navigation alone for %s", (_label, patch) => {
    expect(rowClickOwnsPeek({ ...target, ...patch })).toBe(false);
  });
  it("is exactly where a plain click toggles", () => {
    for (const caretsShown of [false, true]) for (const isDirectory of [false, true]) for (const eligible of [false, true]) {
      expect(rowClickOwnsPeek({ caretsShown, isDirectory, eligible })).toBe(decide({ caretsShown, isDirectory, eligible }));
    }
  });
});

describe("caretlessDoubleClickNotice", () => {
  it("names the Open command's current key", () => {
    expect(caretlessDoubleClickNotice("Enter")).toBe("Double-click is disabled while peek carets are off. Use Enter to navigate into folders.");
    expect(caretlessDoubleClickNotice("Ctrl+O")).toContain("Use Ctrl+O to navigate into folders.");
  });
  it("points to the context menu when Open is unbound", () => {
    expect(caretlessDoubleClickNotice(undefined)).toBe("Double-click is disabled while peek carets are off. Use Open in the context menu to navigate into folders.");
    expect(caretlessDoubleClickNotice("")).toContain("Use Open in the context menu");
  });
});


describe("permanent peek drop destinations (#1323)", () => {
  const meta = new Map([
    ["/root.txt", { depth: 0, parentPath: "/" }],
    ["/Open/file", { depth: 1, parentPath: "/Open" }],
    ["/Open/Nested", { depth: 1, parentPath: "/Open" }],
    ["/Open/Nested/file", { depth: 2, parentPath: "/Open/Nested" }],
  ]);
  const expanded = new Set(["/Open", "/Open/Nested"]);
  it("targets the immediate open parent without inferring ancestry from paths", async () => {
    const { permanentPeekDropFolder: folder } = await import("$lib/domain/folder-peek-flat");
    expect(folder("/Open/file", "file", meta, expanded)).toBe("/Open");
    expect(folder("/Open/Nested/file", "file", meta, expanded)).toBe("/Open/Nested");
    expect(folder("/Open/Nested", "directory", meta, expanded)).toBe("/Open/Nested");
    expect(folder("/Open/Nested", "state", meta, expanded)).toBe("/Open/Nested");
  });
  it("rejects root, removed, unprojected and collapsed file/status rows", async () => {
    const { permanentPeekDropFolder: folder } = await import("$lib/domain/folder-peek-flat");
    expect(folder("/root.txt", "file", meta, expanded)).toBeNull();
    expect(folder("/Open/missing", "file", meta, expanded)).toBeNull();
    expect(folder("/Open/file", "file", meta, new Set())).toBeNull();
    expect(folder("/Closed", "state", meta, expanded)).toBeNull();
  });
});
