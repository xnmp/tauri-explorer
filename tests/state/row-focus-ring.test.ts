/** Restore-type row focus requests the ring state the user last saw (#1729). */
import { describe, expect, it } from "vitest";
import { createRowFocusRing } from "$lib/state/row-focus-ring";

/** A row whose `:focus-visible` match is fixed; other selectors never match. */
const row = (focusVisible: boolean) => ({
  matches: (selector: string) => selector === ":focus-visible" && focusVisible,
});

describe("row focus ring", () => {
  it("shows no ring before any row had focus", () => {
    expect(createRowFocusRing().shown).toBe(false);
  });

  it("follows the last focused row", () => {
    const ring = createRowFocusRing();
    ring.record(row(true));
    expect(ring.shown).toBe(true);
    ring.record(row(false));
    expect(ring.shown).toBe(false);
    ring.record(row(true));
    expect(ring.shown).toBe(true);
  });

  it("treats an engine that rejects :focus-visible as showing no ring", () => {
    const ring = createRowFocusRing();
    ring.record(row(true));
    ring.record({ matches: () => { throw new SyntaxError("unsupported selector"); } });
    expect(ring.shown).toBe(false);
  });

  it("keeps separate instances independent", () => {
    const a = createRowFocusRing();
    const b = createRowFocusRing();
    a.record(row(true));
    expect(b.shown).toBe(false);
  });
});
