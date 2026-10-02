import { afterEach, describe, expect, it, vi } from "vitest";

const { log } = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: log }));

async function traceWith(hooks: boolean) {
  vi.resetModules();
  log.mockClear();
  vi.stubEnv("VITE_E2E_HOOKS", hooks ? "1" : "");
  return import("$lib/state/window-trace");
}

afterEach(() => vi.unstubAllEnvs());

describe("window trace", () => {
  it("logs failures but not progress in a production build", async () => {
    const trace = await traceWith(false);
    trace.traceWindowProgress("window tab seed", { phase: "adopted" });
    trace.traceWindowFailure("window tab seed failed", { phase: "rejected", label: "explorer-1" });
    expect(log.mock.calls).toEqual([["window tab seed failed", { phase: "rejected", label: "explorer-1" }]]);
  });

  it("also logs progress in a hook build", async () => {
    const trace = await traceWith(true);
    trace.traceWindowProgress("window tab seed", { phase: "adopted" });
    trace.traceWindowFailure("window handoff failed", { phase: "timeout" });
    expect(log.mock.calls.map(([event]) => event)).toEqual(["window tab seed", "window handoff failed"]);
  });

  it("bounds rendered errors and leaves an absent error null", async () => {
    const { traceError } = await traceWith(false);
    expect(traceError(undefined)).toBeNull();
    expect(traceError(new Error("gone"))).toBe("Error: gone");
    expect(traceError("y".repeat(10_000))).toHaveLength(240);
  });
});
