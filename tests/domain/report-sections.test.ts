import { describe, expect, it } from "vitest";
import {
  includedDiagnostics,
  OPT_IN_SECTIONS,
  planOptInSections,
} from "$lib/domain/report-sections";
import { MAX_REPORT_DIAGNOSTIC_UNITS, REPORT_TEXT_TRUNCATED } from "$lib/domain/report-diagnostics";

const errors = "This session:\n[ERROR][a] boom ".padEnd(300, "x");
const actions = "1. view:list\n2. nav:navigate ".padEnd(300, "y");
const candidates = { "recent-errors": errors, "recent-actions": actions };

describe("planOptInSections", () => {
  it("offers a section per non-empty candidate, in a fixed order", () => {
    const plan = planOptInSections(candidates, {}, 6000);
    expect(plan.map((s) => s.kind)).toEqual(OPT_IN_SECTIONS.map((s) => s.kind));
    expect(plan.every((s) => s.offered)).toBe(true);
  });

  it("never sends an unchecked section", () => {
    const plan = planOptInSections(candidates, {}, 6000);
    expect(plan.every((s) => !s.included)).toBe(true);
    expect(includedDiagnostics(plan)).toEqual([]);
  });

  it("sends only the ticked sections, with the previewed text", () => {
    const plan = planOptInSections(candidates, { "recent-actions": true }, 6000);
    expect(includedDiagnostics(plan)).toEqual([{ kind: "recent-actions", text: plan[1].text }]);
  });

  it("does not offer empty, whitespace-only or missing candidates", () => {
    const plan = planOptInSections({ "recent-errors": "  \n " }, { "recent-errors": true }, 6000);
    expect(plan.some((s) => s.offered)).toBe(false);
    expect(includedDiagnostics(plan)).toEqual([]);
  });

  it("strips control characters so the preview matches what the native side sends", () => {
    const plan = planOptInSections(
      { "recent-errors": `${"line ".repeat(60)}\u0000\u001b[31mred\u0007` },
      { "recent-errors": true },
      6000,
    );
    expect(plan[0].text).not.toMatch(/[\u0000\u0007\u001b]/);
  });

  it("truncates a huge section to the per-section ceiling", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `[ERROR][a] line ${i}`).join("\n");
    const plan = planOptInSections({ "recent-errors": huge }, { "recent-errors": true }, 20000);
    expect(plan[0].text.length).toBeLessThanOrEqual(MAX_REPORT_DIAGNOSTIC_UNITS);
    expect(plan[0].text.endsWith(REPORT_TEXT_TRUNCATED)).toBe(true);
  });

  it("charges only ticked sections against the shared budget", () => {
    const big = "a".repeat(2500);
    const budget = 2850;
    const unticked = planOptInSections({ "recent-errors": big, "recent-actions": actions }, {}, budget);
    expect(unticked[1].offered).toBe(true);
    const ticked = planOptInSections(
      { "recent-errors": big, "recent-actions": actions },
      { "recent-errors": true },
      budget,
    );
    // 2500 + wrapper leaves too little for a useful second section.
    expect(ticked[1].offered).toBe(false);
  });

  it("offers nothing when the description leaves no room", () => {
    const plan = planOptInSections(candidates, { "recent-errors": true }, 0);
    expect(plan.some((s) => s.offered)).toBe(false);
  });
});
