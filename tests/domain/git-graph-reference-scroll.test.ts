import { describe, expect, it } from "vitest";
import { graphViewportMoved } from "../../src/lib/domain/git-graph";

describe("anchored graph menu viewport ownership", () => {
  it("ignores a notification for scrolling already covered when the menu opened", () => {
    expect(graphViewportMoved({ top: 142.5, left: 21.25 }, { top: 142.5, left: 21.25 })).toBe(false);
  });
  it("dismisses after subsequent vertical or horizontal movement", () => {
    const anchor = { top: 142.5, left: 21.25 };
    expect(graphViewportMoved(anchor, { ...anchor, top: 143 })).toBe(true);
    expect(graphViewportMoved(anchor, { ...anchor, left: 21.5 })).toBe(true);
  });
});
