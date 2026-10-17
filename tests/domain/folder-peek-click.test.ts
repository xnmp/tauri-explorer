import { describe, expect, it } from "vitest";
import { shouldToggleOnRowClick, type RowClickInput } from "$lib/domain/folder-peek";

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
