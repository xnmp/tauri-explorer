import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const apiDir = join(process.cwd(), "src/lib/api");

describe("API module boundaries", () => {
  it("keeps sibling API modules independent of the filesystem module", () => {
    const offenders = readdirSync(apiDir)
      .filter((name) => name.endsWith(".ts") && name !== "files.ts")
      .filter((name) => /from\s+["']\.\/files["']/.test(readFileSync(join(apiDir, name), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("does not restore files.ts as a cross-feature re-export facade", () => {
    const source = readFileSync(join(apiDir, "files.ts"), "utf8");
    expect(source).not.toMatch(/export\s*\{[\s\S]*?\}\s*from\s*["']/);
    expect(source).not.toMatch(/export\s+\*\s+from\s*["']/);
  });
});
