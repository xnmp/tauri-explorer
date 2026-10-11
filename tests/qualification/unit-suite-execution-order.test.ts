import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createVitest } from "vitest/node";
import { expect, it } from "vitest";

it("completes the churn project before admitting ordinary modules with one or multiple workers", async () => {
  mkdirSync(".svelte-kit", { recursive: true });
  const directory = mkdtempSync(resolve(".svelte-kit/suite-order-"));
  try {
    for (const maxWorkers of [1, 2]) {
      const journal = resolve(directory, `events-${maxWorkers}.txt`);
      const churnProbe = resolve(directory, `churn-${maxWorkers}.test.ts`);
      const unitProbe = resolve(directory, `unit-${maxWorkers}.test.ts`);
      // Lightweight real worker modules expose admission at module evaluation,
      // before test collection. They use the production projects' scheduler,
      // without duplicating the expensive lifecycle test inside the unit suite.
      const header = `import { appendFileSync } from "node:fs";
import { it } from "vitest";
const record = event => appendFileSync(${JSON.stringify(journal)}, event + "\\n");`;
      writeFileSync(churnProbe, `${header}
record("churn:admitted");
it("finishes churn", async () => {
  await new Promise(resolve => setTimeout(resolve, 25));
  record("churn:completed");
});`);
      writeFileSync(unitProbe, `${header}
record("unit:admitted");
it("runs ordinary work", () => {});`);
      const runner = await createVitest({
        config: resolve("vitest.config.ts"), watch: false, maxWorkers, reporters: [],
      });
      try {
        // File discovery binds each probe to the project that owns the actual
        // production test. Only the module payload changes, not its config,
        // pool, sequencing or worker admission implementation.
        const selected = await runner.globTestSpecifications([
          "tests/plugins/registry-churn.test.ts", "tests/domain/git-pr-target.test.ts",
        ]);
        expect(selected).toHaveLength(2);
        const probes = selected.map(spec => spec.project.createSpecification(
          spec.moduleId.endsWith("/registry-churn.test.ts") ? churnProbe : unitProbe,
          undefined, spec.pool,
        ));
        const result = await runner.runTestSpecifications(probes);
        expect(result.unhandledErrors).toEqual([]);
        expect(result.testModules.map(module => module.state())).toEqual(["passed", "passed"]);
        expect(readFileSync(journal, "utf8").trim().split("\n"), `maxWorkers=${maxWorkers}`)
          .toEqual(["churn:admitted", "churn:completed", "unit:admitted"]);
      } finally {
        await runner.close();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
