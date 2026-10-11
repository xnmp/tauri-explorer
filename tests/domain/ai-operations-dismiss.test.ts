import { describe, it, expect } from "vitest";
import { resolutionAvailable, resolutionCopy, validAiOperations, type UnresolvedAiOperation } from "$lib/domain/ai-operations";

const row = (extra: Partial<UnresolvedAiOperation> = {}): UnresolvedAiOperation => ({
  operationId: "op-1", consumerPackage: "c", providerPackage: "p", createdAtMs: null, execution: "unknown", delivery: "none",
  reason: "Automatic recovery stopped; unknown execution evidence is retained", canResume: false, canDiscard: false, canStop: false, ...extra,
});

describe("dismiss resolution", () => {
  it("is available only when the host reports canDismiss", () => {
    expect(resolutionAvailable(row({ canDismiss: true }), "dismiss")).toBe(true);
    expect(resolutionAvailable(row({ canDismiss: false }), "dismiss")).toBe(false);
  });
  it("is unavailable for snapshots from older hosts that omit canDismiss", () => {
    expect(resolutionAvailable(row(), "dismiss")).toBe(false);
  });
  it("does not make other actions available", () => {
    const r = row({ canDismiss: true });
    expect(["resume", "discard", "stop"].map((a) => resolutionAvailable(r, a as never))).toEqual([false, false, false]);
  });
  it("explains that the outcome stays unknown, evidence is kept and nothing is retried", () => {
    const copy = resolutionCopy(row({ canDismiss: true }), "dismiss");
    expect(copy.body).toContain("outcome stays unknown");
    expect(copy.body).toContain("evidence is kept");
    expect(copy.body).toContain("will not be retried");
    expect(copy.body).toContain("op-1");
    expect(copy.button).toBe("Dismiss operation");
  });
});

describe("validAiOperations canDismiss", () => {
  const snap = (extra: Record<string, unknown>) => ({ version: 1, operations: [{ ...row(), ...extra }] });
  it.each([undefined, true, false])("accepts %s", (v) => expect(validAiOperations(snap(v === undefined ? {} : { canDismiss: v }))).toBe(true));
  it.each(["true", 1, null, {}])("rejects non-boolean %s", (v) => expect(validAiOperations(snap({ canDismiss: v }))).toBe(false));
});
