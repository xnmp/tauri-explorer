/** Restore-type row focus requests the ring state the user last saw (#1729). */
import { describe, expect, it } from "vitest";
import { createRowFocusRing } from "$lib/state/row-focus-ring";

/** A row focused by the keyboard matches `:focus-visible`; a clicked one does not. */
const keyboardFocusedRow = { matches: (selector: string) => selector === ":focus-visible" };
const clickedRow = { matches: () => false };
const unsupportedEngineRow = { matches: () => { throw new SyntaxError("unsupported selector"); } };

describe("row focus ring", () => {
  it("leaves a restore to the browser before any row had focus", () => {
    expect(createRowFocusRing().shown).toBeUndefined();
  });

  it("restores with the ring after the user moved between rows by keyboard", () => {
    const ring = createRowFocusRing();
    ring.record(clickedRow);
    ring.record(keyboardFocusedRow);
    expect(ring.shown).toBe(true);
  });

  it("restores without the ring after a click, even after earlier keyboard use", () => {
    const ring = createRowFocusRing();
    ring.record(keyboardFocusedRow);
    ring.record(clickedRow);
    expect(ring.shown).toBe(false);
  });

  it("leaves a restore to the browser where the engine cannot report :focus-visible", () => {
    const ring = createRowFocusRing();
    ring.record(keyboardFocusedRow);
    ring.record(unsupportedEngineRow);
    expect(ring.shown).toBeUndefined();
  });
});
