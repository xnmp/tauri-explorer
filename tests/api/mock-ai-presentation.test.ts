import { describe, expect, it } from "vitest";
import { createMockAiPresentation } from "$lib/api/mock-ai-presentation";
import type { NativeJobRecord } from "$lib/domain/native-plugin-jobs";
const job = (state: NativeJobRecord["state"], phase?: string): NativeJobRecord => ({ jobKey: "a".repeat(48), owner: { packageId: "consumer", digest: "b".repeat(64), incarnation: 1 }, operationId: "original", jobId: 51, kind: "image", label: "output.png", originWindow: "mock-window", revision: 1, createdAtMs: 1, updatedAtMs: 2, state, phase });
const operation = { operationId: "original", consumerPackage: "consumer", providerPackage: "provider", createdAtMs: 1, execution: "unknown", delivery: "none", reason: "Outcome unknown", canResume: true, canStop: true, canDiscard: false };
describe("native presentation mock outcomes", () => {
  it("active cancel/resume remain intents; terminal presentation can be dismissed", () => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("recovering")] }, { version: 1, operations: [{ ...operation, active: true }] });
    mock.cancel(job("running").jobKey); mock.resume(job("running").jobKey);
    expect(mock.snapshot().jobs[0].state).toBe("recovering");
    expect(() => mock.dismiss(job("running").jobKey)).toThrow("cannot be dismissed");
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("completed")] }, { version: 1, operations: [] });
    mock.dismiss(job("completed").jobKey);
    expect(mock.snapshot().jobs).toEqual([]);
    expect(mock.calls.map(r => r.command)).toEqual(["cancel", "resume", "dismiss"]);
  });
  it.each(["unknown", "failed", "unconfirmed"])("settles idle %s execution automatically and preserves its reason", execution => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("needs_attention", "stopped")] }, { version: 1, operations: [{ ...operation, execution, active: false }] });
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "discarded", error: "Outcome unknown" });
    expect(mock.operationSnapshot().operations).toEqual([]);
    expect(mock.calls.filter(r => r.command === "resume")).toEqual([]);
    const settled = mock.snapshot(); mock.seed(settled);
    expect(mock.snapshot()).toEqual(settled);
  });
  it("fills a finished failure's missing reason without changing its outcome or settled time", () => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [{ ...job("error"), settledAtMs: 2 }] }, { version: 1, operations: [{ ...operation, execution: "failed", active: false }] });
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "error", settledAtMs: 2, error: "Outcome unknown" });
    expect(mock.operationSnapshot().operations).toEqual([]);
    const settled = mock.snapshot(); mock.seed(settled);
    expect(mock.snapshot()).toEqual(settled);
  });
  it.each(["none", "available", "unavailable", "acquired", "discarded"])("drives succeeded %s output without fabricating completion", delivery => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("needs_attention")] }, { version: 1, operations: [{ ...operation, execution: "succeeded", delivery, canDiscard: true, active: false }] });
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "recovering", phase: "acquiring" });
    expect(mock.operationSnapshot().operations[0]).toMatchObject({ execution: "succeeded", delivery, active: true });
    expect(mock.calls.map(r => r.command)).toEqual(["resume"]);
    mock.seed({ originWindow: "mock-window", watermark: 3, jobs: [{ ...job("completed"), revision: 3, outputPath: "/output.png" }] }, { version: 1, operations: [] });
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "completed", outputPath: "/output.png" });
  });
  it.each([
    ["unknown", "running"], ["unknown", "recovering"], ["failed", "running"], ["failed", "recovering"],
  ] as const)("settles inactive %s execution despite stale %s presentation", (execution, state) => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job(state)] }, { version: 1, operations: [{ ...operation, execution, active: false }] });
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "discarded", error: "Outcome unknown" });
    expect(mock.operationSnapshot().operations).toEqual([]);
    expect(mock.calls.map(call => call.action)).toEqual(["dismiss"]);
  });
  it.each(["available", "unavailable", "acquired"])("never resumes Unknown execution claiming %s output", delivery => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("recovering")] }, { version: 1, operations: [{ ...operation, delivery, canResume: true, canDiscard: true, active: false }] });
    expect(mock.snapshot().jobs[0].state).toBe("discarded");
    expect(mock.calls.map(call => call.command)).toEqual(["auto-settle"]);
    expect(mock.calls[0].action).toBe("dismiss");
  });
  it.each(["missing", "corrupt"])("retains and retries a successful %s result", deliveryReason => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("recovering")] }, { version: 1, operations: [{ ...operation, execution: "succeeded", delivery: "unavailable", deliveryReason, reason: `Original output ${deliveryReason}`, canDiscard: true, active: false }] });
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "error", phase: "delivery_failed" });
    expect(mock.operationSnapshot().operations).toHaveLength(1);
    expect(mock.calls.map(call => [call.command, call.action])).toEqual([["resume", undefined]]);
    const failed = mock.snapshot(); mock.seed(failed);
    expect(mock.snapshot().jobs).toEqual(failed.jobs);
    expect(mock.calls.map(call => call.command)).toEqual(["resume", "resume"]);
  });
  it("recovers original output when storage is temporarily unavailable", () => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("needs_attention")] }, { version: 1, operations: [{ ...operation, execution: "succeeded", delivery: "unavailable", deliveryReason: "storage_unavailable", canDiscard: true, active: false }] });
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "recovering", phase: "acquiring" });
    expect(mock.operationSnapshot().operations[0].active).toBe(true);
    expect(mock.calls.map(call => call.command)).toEqual(["resume"]);
  });
  it("recovers missing output regardless of explicit discard capability", () => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("needs_attention")] }, { version: 1, operations: [{ ...operation, execution: "succeeded", delivery: "unavailable", deliveryReason: "missing", canDiscard: false, active: false }] });
    expect(mock.operationSnapshot().operations).toHaveLength(1);
    expect(mock.snapshot().jobs[0].state).toBe("error");
    expect(mock.calls.map(call => call.command)).toEqual(["resume"]);
  });
  it("retains successful output when its original package cannot drive it", () => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("needs_attention")] }, { version: 1, operations: [{ ...operation, execution: "succeeded", delivery: "available", canResume: false, active: false }] });
    expect(mock.snapshot().jobs[0].state).toBe("needs_attention");
    expect(mock.operationSnapshot().operations).toHaveLength(1);
    expect(mock.calls).toEqual([]);
  });
  it("Stop automatically settles unknown evidence rather than leaving attention", () => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("recovering")] }, { version: 1, operations: [{ ...operation, active: true }] });
    expect(mock.resolve("consumer", "original", "stop").operations).toEqual([]);
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "discarded", phase: "stopped" });
    expect(mock.calls.map(r => r.command)).toEqual(["resolve", "auto-settle"]);
  });
  it("a provider discard settles presentation without inventing completion", () => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("recovering")] }, { version: 1, operations: [{ ...operation, execution: "succeeded", delivery: "available", canDiscard: true, active: true }] });
    expect(mock.resolve("consumer", "original", "discard").operations).toEqual([]);
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "discarded", phase: "provider_result_discarded" });
  });
  it("rejects malformed fixtures before publishing a settlement", () => {
    const mock = createMockAiPresentation(() => {});
    expect(() => mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("running")] }, { version: 1, operations: [{ ...operation, active: "yes" }] } as never)).toThrow("Invalid native presentation fixture");
    expect(mock.snapshot().jobs).toEqual([]);
    expect(mock.calls).toEqual([]);
  });
});
