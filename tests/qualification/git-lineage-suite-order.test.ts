import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createVitest } from "vitest/node";
import { expect, it } from "vitest";

it("finishes graph timing before admitting parallel unit modules without changing worker limits", async () => {
  mkdirSync(".svelte-kit", { recursive: true });
  const directory = mkdtempSync(resolve(".svelte-kit/lineage-suite-order-"));
  const runner = await createVitest({
    config: resolve("vitest.config.ts"), watch: false, maxWorkers: 2, reporters: [],
  });
  try {
    const graphFile = "tests/domain/git-graph-branch-line.test.ts";
    const unitFile = "tests/domain/git-pr-target.test.ts";
    const selected = await runner.globTestSpecifications([graphFile, unitFile]);
    expect(selected).toHaveLength(2);
    const graph = selected.find(spec => spec.moduleId.endsWith(graphFile))!;
    const unit = selected.find(spec => spec.moduleId.endsWith(unitFile))!;
    expect(graph).toBeDefined();
    expect(unit).toBeDefined();
    expect(graph.project.config.sequence.groupOrder).toBeLessThan(unit.project.config.sequence.groupOrder);
    for (const spec of selected) {
      expect(spec.project.config.maxWorkers).toBe(2);
      expect(spec.project.config.testTimeout).toBe(5_000);
      const alone = await runner.globTestSpecifications([spec.moduleId]);
      expect(alone.map(item => item.moduleId)).toEqual([spec.moduleId]);
    }

    const journal = resolve(directory, "events.txt");
    const header = `import { appendFileSync } from "node:fs";
import { it } from "vitest";
const record = event => appendFileSync(${JSON.stringify(journal)}, event + "\\n");`;
    const graphProbe = resolve(directory, "graph.test.ts");
    const unitProbe = resolve(directory, "unit.test.ts");
    writeFileSync(graphProbe, `${header}
record("graph:admitted");
it("finishes graph work", async () => {
  await new Promise(resolve => setTimeout(resolve, 25));
  record("graph:completed");
});`);
    writeFileSync(unitProbe, `${header}
record("unit:admitted");
it("runs unit work", () => {});`);
    // Resolve ownership from the actual files, then exercise the real scheduler
    // with small worker payloads rather than nesting another performance suite.
    const probes = [
      graph.project.createSpecification(graphProbe, undefined, graph.pool),
      unit.project.createSpecification(unitProbe, undefined, unit.pool),
    ];
    const result = await runner.runTestSpecifications(probes);
    expect(result.unhandledErrors).toEqual([]);
    expect(result.testModules.map(module => module.state())).toEqual(["passed", "passed"]);
    expect(readFileSync(journal, "utf8").trim().split("\n"))
      .toEqual(["graph:admitted", "graph:completed", "unit:admitted"]);
  } finally {
    await runner.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
