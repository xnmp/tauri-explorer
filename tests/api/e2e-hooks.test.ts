import { afterEach, describe, expect, it, vi } from "vitest";

// Loading the real test-support graph would pull in every window store; the
// gate's contract is only whether the entry point is reachable.
vi.mock("../../src/test-support/e2e-hooks", () => ({ startWindowSessionProbe: vi.fn() }));

async function gateWith(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("VITE_E2E_HOOKS", undefined as unknown as string);
  else vi.stubEnv("VITE_E2E_HOOKS", value);
  return import("$lib/api/e2e-hooks");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("E2E hook gate", () => {
  it("installs no hooks when the build flag is absent", async () => {
    const gate = await gateWith(undefined);
    expect(gate.E2E_HOOKS_ENABLED).toBe(false);
    expect(gate.loadE2EHooks()).toBeNull();
  });

  it.each(["0", "", "true", "yes", " 1"])("treats %j as disabled: only the literal \"1\" opts in", async (value) => {
    const gate = await gateWith(value);
    expect(gate.E2E_HOOKS_ENABLED).toBe(false);
    expect(gate.loadE2EHooks()).toBeNull();
  });

  it("loads the test-support entry point when the build flag is \"1\"", async () => {
    const gate = await gateWith("1");
    expect(gate.E2E_HOOKS_ENABLED).toBe(true);
    const hooks = await gate.loadE2EHooks();
    expect(hooks?.startWindowSessionProbe).toBeTypeOf("function");
  });

  it("does not treat a dev build as a hook build", async () => {
    vi.stubEnv("DEV", true);
    const gate = await gateWith(undefined);
    expect(gate.E2E_HOOKS_ENABLED).toBe(false);
    expect(gate.loadE2EHooks()).toBeNull();
  });
});
