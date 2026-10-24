import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The test-impact map (#1368) records coverage through an auto fixture in
// e2e/fixtures.ts. A spec that takes `test` from "@playwright/test" directly
// records nothing, so PR selection would see it as a spec without coverage
// (always selected) at best, and would miss its own contexts at worst.
const dir = new URL("../e2e/", import.meta.url);
const specs = readdirSync(dir).filter((name) => name.endsWith(".spec.ts"));

describe("browser specs use the shared fixtures (#1368)", () => {
  it("finds the browser specs", () => {
    expect(specs.length).toBeGreaterThan(100);
  });

  it.each(specs)("%s takes test from ./fixtures", (name) => {
    const text = readFileSync(new URL(name, dir), "utf8");
    const runtimeImports = [...text.matchAll(/^import\s+(?!type\b)\{([^}]*)\}\s+from\s+["']@playwright\/test["']/gm)]
      .flatMap((m) => m[1].split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("type ")));
    expect(runtimeImports, "import runtime values from ./fixtures, not @playwright/test").toEqual([]);
    expect(text).toMatch(/^import\s+\{[^}]*\btest\b[^}]*\}\s+from\s+["']\.\/fixtures["']/m);
  });
});
