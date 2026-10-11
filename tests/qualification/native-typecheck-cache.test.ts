import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createVitest } from "vitest/node";

describe("native compiler metadata reuse", () => {
  it("persists successful checks and still rejects a changed imported contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "native-typecheck-cache-"));
    try {
      const config = join(dir, "tsconfig.json");
      const cache = join(dir, "native.tsbuildinfo");
      writeFileSync(config, JSON.stringify({
        extends: resolve("e2e-tauri/tsconfig.json"),
        compilerOptions: { types: [], tsBuildInfoFile: cache },
        include: ["./*.ts"],
      }));
      writeFileSync(join(dir, "contract.ts"), 'export const value: string = "valid";\n');
      writeFileSync(join(dir, "consumer.ts"), 'import { value } from "./contract"; export const result: string = value;\n');
      const check = () => spawnSync("bun", [resolve("node_modules/typescript/bin/tsc"), "--noEmit", "-p", config], { encoding: "utf8" });
      const cold = check();
      expect(cold.status, cold.stdout + cold.stderr).toBe(0);
      expect(existsSync(cache)).toBe(true);
      const metadata = readFileSync(cache, "utf8");
      const warm = check();
      expect(warm.status, warm.stdout + warm.stderr).toBe(0);
      expect(readFileSync(cache, "utf8")).toBe(metadata);
      writeFileSync(join(dir, "contract.ts"), "export const value: number = 42;\n");
      const changed = check();
      expect(changed.status).not.toBe(0);
      expect(changed.stdout + changed.stderr).toContain("not assignable to type 'string'");
      writeFileSync(join(dir, "contract.ts"), 'export const value: string = "repaired";\n');
      const repaired = check();
      expect(repaired.status, repaired.stdout + repaired.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

// Compiler subprocess probes must finish before the transform-heavy unit group.
it("schedules the cache contract check before ordinary unit work", async () => {
  const runner = await createVitest({ config: resolve("vitest.config.ts"), watch: false, maxWorkers: 2 });
  try {
    const specs = await runner.globTestSpecifications([
      "tests/native-suite-typecheck.test.ts", "tests/qualification/native-typecheck-cache.test.ts",
      "tests/domain/git-pr-target.test.ts",
    ]);
    expect(specs).toHaveLength(3);
    const order = (suffix: string) => specs.find(spec => spec.moduleId.endsWith(suffix))!.project.config.sequence.groupOrder;
    expect(order("/native-typecheck-cache.test.ts")).toBeGreaterThan(order("/native-suite-typecheck.test.ts"));
    expect(order("/native-typecheck-cache.test.ts")).toBeLessThan(order("/git-pr-target.test.ts"));
  } finally { await runner.close(); }
}, 20_000);
