import { describe, it, expect } from "vitest";
import { needsAttentionCount, unresolvedIndicator, validAiOperations } from "$lib/domain/ai-operations";

describe("unresolvedIndicator", () => {
  it("is hidden with nothing unresolved", () => expect(unresolvedIndicator(0)).toBeNull());
  it("shows count and accessible name for one", () =>
    expect(unresolvedIndicator(1)).toEqual({ text: "1 unresolved", label: "Unresolved AI operations: 1" }));
  it("shows count for many", () =>
    expect(unresolvedIndicator(42)).toEqual({ text: "42 unresolved", label: "Unresolved AI operations: 42" }));
  it.each([-1, 1.5, NaN, Infinity, "3", null, undefined, {}, Number.MAX_VALUE])("is hidden for malformed %s", (v) =>
    expect(unresolvedIndicator(v)).toBeNull());
});

const row = (operationId: string, extra: Record<string, unknown> = {}): any => ({ operationId, consumerPackage: "c", providerPackage: "p", createdAtMs: null, execution: "running", delivery: "none", reason: "r", canResume: true, canDiscard: false, canStop: false, ...extra });
describe("needsAttentionCount", () => {
  it("is zero when every row is active", () => expect(needsAttentionCount({ operations: [row("a", { active: true })] })).toBe(0));
  it("counts inactive rows and rows from older snapshots without the flag", () =>
    expect(needsAttentionCount({ operations: [row("a", { active: true }), row("b", { active: false }), row("c")] })).toBe(2));
  it("is zero for an empty snapshot", () => expect(needsAttentionCount({ operations: [] })).toBe(0));
});
describe("validAiOperations active flag", () => {
  const snap = (extra?: Record<string, unknown>) => ({ version: 1, operations: [row("a", extra)] });
  it.each([undefined, true, false])("accepts %s", (v) => expect(validAiOperations(snap(v === undefined ? {} : { active: v }))).toBe(true));
  it.each(["true", 1, null, {}])("rejects non-boolean %s", (v) => expect(validAiOperations(snap({ active: v }))).toBe(false));
});
