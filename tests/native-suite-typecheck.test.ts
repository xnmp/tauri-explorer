import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

describe("native suite TypeScript gate (#690)", () => {
  let result: SpawnSyncReturns<string>;

  beforeAll(() => {
    // Compilation is suite setup, not a five-second application-behavior
    // contract. Bound the subprocess so a stuck compiler still fails the gate.
    result = spawnSync(
      "bun",
      ["run", "check:e2e:tauri"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
    );
  });

  it("typechecks the native WebdriverIO suite through its public command", () => {
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
