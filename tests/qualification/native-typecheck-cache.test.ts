import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("native compiler metadata reuse", () => {
  it("persists successful checks and still rejects a changed imported contract", () => {
    // Worktree checks can inherit dependencies from a parent installation.
    const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
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
      const check = () => spawnSync("bun", [compiler, "--noEmit", "-p", config], { encoding: "utf8" });
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
