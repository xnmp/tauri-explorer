import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createVitest } from "vitest/node";
import { expect, it } from "vitest";

it("runs the unchanged registry churn before other files without losing or duplicating unit coverage", async () => {
  // Resolve the real runner configuration, including inherited Svelte plugins,
  // glob selection and CLI worker overrides. Do not execute a nested test suite.
  const runner = await createVitest({
    config: resolve("vitest.config.ts"),
    watch: false,
    maxWorkers: 2,
  });
  try {
    const specs = await runner.globTestSpecifications();
    const files = specs.map(spec => relative(process.cwd(), spec.moduleId).replaceAll("\\", "/"));
    const expected = readdirSync("tests", { recursive: true })
      .filter((file): file is string => typeof file === "string")
      .map(file => file.replaceAll("\\", "/"))
      .filter(file => !file.startsWith("perf/") && /\.(test|bench)\.ts$/.test(file))
      .map(file => `tests/${file}`);
    expect(files.toSorted()).toEqual(expected.toSorted());
    expect(new Set(files).size).toBe(files.length);

    const churn = specs.find(spec => spec.moduleId.endsWith("/tests/plugins/registry-churn.test.ts"));
    expect(churn).toBeDefined();
    const others = specs.filter(spec => spec !== churn);
    expect(others.length).toBeGreaterThan(0);
    for (const spec of others) {
      expect(spec.project.config.sequence.groupOrder).toBeGreaterThan(churn!.project.config.sequence.groupOrder);
    }
    const compiler = others.find(spec => spec.moduleId.endsWith("/tests/native-suite-typecheck.test.ts"));
    expect(compiler).toBeDefined();
    for (const spec of others.filter(spec => spec !== compiler)) {
      expect(spec.project.config.sequence.groupOrder).toBeGreaterThan(compiler!.project.config.sequence.groupOrder);
    }
    for (const spec of specs) {
      expect(spec.project.config.testTimeout).toBe(5_000);
      expect(spec.project.config.maxWorkers).toBe(2);
    }

    // The developer's ordinary single-file invocation must still work, without
    // matching both projects or running unrelated files.
    for (const file of ["tests/plugins/registry-churn.test.ts", "tests/native-suite-typecheck.test.ts", "tests/state/git-pr-session.test.ts"]) {
      const selected = await runner.globTestSpecifications([file]);
      expect(selected.map(spec => relative(process.cwd(), spec.moduleId).replaceAll("\\", "/"))).toEqual([file]);
    }
  } finally {
    await runner.close();
  }
// Configuration startup is a separate integration operation, not a relaxation
// of any existing test's deadline. This also runs on a contended full suite.
}, 20_000);
