import { describe, expect, it } from "vitest";
import { createMockAiPresentation } from "$lib/api/mock-ai-presentation";
import type { NativeJobRecord } from "$lib/domain/native-plugin-jobs";
const job = (state: NativeJobRecord["state"]): NativeJobRecord => ({ jobKey: "a".repeat(48), owner: { packageId: "consumer", digest: "b".repeat(64), incarnation: 1 }, operationId: "original", jobId: 51, kind: "image", label: "output.png", originWindow: "mock-window", revision: 1, createdAtMs: 1, updatedAtMs: 2, state });
const operation = { operationId: "original", consumerPackage: "consumer", providerPackage: "provider", createdAtMs: 1, execution: "unknown", delivery: "none", reason: "Outcome unknown", canResume: true, canStop: true, canDiscard: false };
describe("native presentation mock outcomes", () => {
  it("cancel/resume remain intents; only explicit terminal presentation can be dismissed", () => {
    const events: unknown[] = []; const mock = createMockAiPresentation((name, value) => events.push([name, value]));
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("recovering")] }, { version: 1, operations: [operation] });
    mock.cancel(job("running").jobKey); mock.resume(job("running").jobKey);
    expect(mock.snapshot().jobs[0].state).toBe("recovering");
    expect(() => mock.dismiss(job("running").jobKey)).toThrow("cannot be dismissed");
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("completed")] });
    mock.dismiss(job("completed").jobKey);
    expect(mock.snapshot().jobs).toEqual([]); expect(mock.operationSnapshot().operations).toEqual([operation]);
    expect(events).toContainEqual(["plugin-jobs:changed", { type: "dismissed", jobKey: job("completed").jobKey, revision: 2 }]);
    expect(mock.calls.map(r => r.command)).toEqual(["cancel", "resume", "dismiss"]);
  });
  it("Stop retains unknown evidence and linked attention; provider discard never fabricates consumer completion", () => {
    const mock = createMockAiPresentation(() => {});
    mock.seed({ originWindow: "mock-window", watermark: 1, jobs: [job("recovering")] }, { version: 1, operations: [operation] });
    const stopped = mock.resolve("consumer", "original", "stop");
    expect(stopped.operations[0]).toMatchObject({ execution: "unknown", delivery: "none", canResume: false, canStop: false });
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "needs_attention", phase: "stopped" });
    expect(() => mock.resolve("consumer", "original", "stop")).toThrow("unavailable");
    mock.seed({ originWindow: "mock-window", watermark: 2, jobs: mock.snapshot().jobs }, { version: 1, operations: [{ ...operation, execution: "succeeded", delivery: "available", canDiscard: true, canStop: false }] });
    expect(() => mock.resolve("foreign", "original", "discard")).toThrow("unavailable");
    expect(mock.resolve("consumer", "original", "discard").operations).toEqual([]);
    expect(mock.snapshot().jobs[0]).toMatchObject({ state: "needs_attention", phase: "provider_result_discarded" });
    expect(mock.calls.map(r => r.action)).toEqual(["stop", "discard"]);
    // Dismissal removes settled presentation only, as the host does.
    mock.dismiss(job("recovering").jobKey);
    expect(mock.snapshot().jobs).toEqual([]);
  });
});
