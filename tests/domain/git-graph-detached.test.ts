/**
 * Standing detached-HEAD indicator (#524).
 *
 * Detached HEAD is a MODE: while it lasts every commit belongs to no branch,
 * so the graph shows a permanent badge instead of only mentioning it inside
 * the transient checkout menu. The presenter is pure so the "is it showing,
 * and what does it say" question is answerable without a browser.
 */
import { describe, it, expect } from "vitest";
import { detachedHeadIndicator } from "$lib/domain/git-graph";

const OID = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

describe("detachedHeadIndicator", () => {
  it("shows nothing while HEAD is attached to a branch", () => {
    expect(detachedHeadIndicator(false, OID)).toBeNull();
  });

  it("labels the detached state with the abbreviated HEAD commit", () => {
    const indicator = detachedHeadIndicator(true, OID);
    expect(indicator).not.toBeNull();
    expect(indicator!.label).toBe("DETACHED HEAD @ 1a2b3c4");
    // The tooltip has to say what the state costs the user, not restate the label.
    expect(indicator!.title).toContain("1a2b3c4");
    expect(indicator!.title.toLowerCase()).toContain("no branch");
  });

  it("still warns when the HEAD commit is unknown", () => {
    // Unborn/empty repo, or a payload that arrived without a Head decoration:
    // the state is still detached, so the badge must not silently vanish.
    for (const oid of [null, ""]) {
      const indicator = detachedHeadIndicator(true, oid);
      expect(indicator).not.toBeNull();
      expect(indicator!.label).toBe("DETACHED HEAD");
      expect(indicator!.label).not.toContain("@");
    }
  });
});
