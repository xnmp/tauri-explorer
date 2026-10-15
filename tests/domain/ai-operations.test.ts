import { describe, expect, it } from "vitest";
import { resolutionAvailable, validAiOperations, type AiOperation } from "$lib/domain/ai-operations";
const row: AiOperation = { operationId: "original", consumerPackage: "consumer", providerPackage: "provider", createdAtMs: null, execution: "unknown", delivery: "none", reason: "Outcome unknown", canResume: false, canDiscard: false, canStop: false };
const snapshot = (patch: Record<string, unknown> = {}) => ({ version: 1, operations: [{ ...row, ...patch }] });
describe("private native AI operation fixture contract", () => {
  it("accepts empty snapshots and optional legacy capabilities", () => {
    expect(validAiOperations({ version: 1, operations: [] })).toBe(true);
    for (const value of [undefined, true, false]) expect(validAiOperations(snapshot({ active: value, canDismiss: value }))).toBe(true);
  });
  it.each([null, {}, [], { version: 2, operations: [] }, snapshot({ active: 1 }), snapshot({ canDismiss: "true" }), snapshot({ operationId: "a\0b" }), snapshot({ reason: "x".repeat(2049) }), snapshot({ deliveryReason: null }), snapshot({ deliveryReason: 1 }), snapshot({ deliveryReason: "x".repeat(129) }), snapshot({ deliveryReason: "\0" }), snapshot({ deliveryReason: "🎨".repeat(33) }), { version: 1, operations: [row, row] }, { version: 1, operations: Array.from({ length: 257 }, (_, i) => ({ ...row, operationId: `op-${i}` })) }])("rejects malformed or excessive data %#", value => expect(validAiOperations(value)).toBe(false));
  it.each([undefined, "missing", "corrupt", "storage_unavailable", "future_reason"])("accepts optional bounded delivery evidence %s", deliveryReason => expect(validAiOperations(snapshot({ deliveryReason }))).toBe(true));
  it("authorizes only actions offered by the native capability snapshot", () => {
    for (const action of ["resume", "discard", "stop", "dismiss"] as const) expect(resolutionAvailable(row, action)).toBe(false);
    expect(resolutionAvailable({ ...row, canDismiss: true }, "dismiss")).toBe(true);
    expect(resolutionAvailable({ ...row, canResume: true }, "resume")).toBe(true);
  });
});
