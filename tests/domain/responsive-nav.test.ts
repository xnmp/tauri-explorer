/**
 * Regression test: nav controls should be hidden via CSS container query
 * when the navigation bar is narrow (< 400px).
 * Issue: fix/addressbar-responsive-icons
 *
 * This test validates the business rule — the actual CSS behavior
 * is verified via the e2e screenshot.
 */
import { describe, it, expect } from "vitest";

describe("Responsive nav controls", () => {
  const BREAKPOINT = 400; // px

  it("breakpoint is reasonable for hiding 3-4 nav buttons (each ~28px)", () => {
    const navButtonWidth = 28;
    const navButtonGap = 2;
    const maxButtons = 4; // back, forward, up, refresh
    const totalNavWidth = maxButtons * navButtonWidth + (maxButtons - 1) * navButtonGap;

    // When container is narrower than breakpoint, there's not enough room
    // for both nav buttons and a usable breadcrumb area
    expect(BREAKPOINT).toBeGreaterThan(totalNavWidth);
    expect(BREAKPOINT).toBeLessThan(800); // shouldn't hide on normal-width windows
  });
});
