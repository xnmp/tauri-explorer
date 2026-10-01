import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("native suite TypeScript gate (#690)", () => {
  it("typechecks the native WebdriverIO suite through its public command", () => {
    const result = spawnSync(
      "bun",
      ["run", "check:e2e:tauri"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
