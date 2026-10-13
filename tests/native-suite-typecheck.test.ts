import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("native suite TypeScript gate (#690)", () => {
  it("typechecks the native WebdriverIO suite through its public command", () => {
    const result = spawnSync(
      "bun",
      ["run", "check:e2e:tauri"],
      // This launches a compiler, not a latency benchmark. Bound the child
      // explicitly; Vitest's default 5s can expire on a healthy slower host.
      { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
  }, 35_000);
});
