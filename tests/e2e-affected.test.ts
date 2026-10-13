import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classify, devServerScripts } from "../scripts/e2e-affected.mjs";

// An existing spec, so the "changed spec selects itself" rule can see it on disk.
const SPEC = "e2e/quickopen-debug.spec.ts";

const map = {
  hubs: ["routes/+page.svelte"],
  clusters: [
    { title: "Quick Open", files: ["components/QuickOpen.svelte"], phrases: new Set(["quick-open"]) },
    { title: "Orphan", files: ["components/Orphan.svelte"], phrases: new Set(["nothing-matches-this"]) },
  ],
};
const specs = [
  { rel: "e2e/quick-open.spec.ts", content: "test('quick-open finds files')" },
  { rel: "e2e/other.spec.ts", content: "test('unrelated')" },
];

const select = (changed: string[], devServerInputs = new Set<string>()) => {
  const { all, selected } = classify(changed, map, specs, devServerInputs);
  return all ? "ALL" : [...selected].sort();
};

describe("classify", () => {
  it("ignores files the browser suite never executes", () => {
    expect(
      select([
        "src-tauri/src/files/move_session.rs",
        "src-tauri/Cargo.toml",
        "tests/state/window-tabs.test.ts",
        "evidence/ac-1-something.png",
        "docs/lessons/1-x.md",
        "README.md",
        "scripts/qualify-macos-startup.ts",
        "e2e-tauri/specs/x.spec.ts",
        "vitest.config.ts",
        "vitest.perf.config.ts",
      ]),
    ).toEqual([]);
  });

  it("selects a changed spec and the specs of a changed source file's cluster", () => {
    expect(select([SPEC, "src/lib/components/QuickOpen.svelte"])).toEqual([SPEC, "e2e/quick-open.spec.ts"].sort());
  });

  it("does not select a deleted spec", () => {
    expect(select(["e2e/deleted-long-ago.spec.ts"])).toEqual([]);
  });

  it.each([
    ["the mock backend", "src/lib/api/mock-invoke.ts"],
    ["shared e2e helpers", "e2e/helpers.ts"],
    ["e2e fixtures", "e2e/fixtures.ts"],
    ["a central hub", "src/routes/+page.svelte"],
    ["an unmapped source file", "src/lib/domain/brand-new.ts"],
    ["a cluster that resolves to no spec", "src/lib/components/Orphan.svelte"],
    ["package.json", "package.json"],
    ["the lockfile", "bun.lock"],
    ["the Playwright config", "playwright.config.ts"],
    ["the Vite config", "vite.config.ts"],
    ["the CI workflow that selects specs", ".github/workflows/ci.yml"],
    ["the shard planner", "scripts/e2e-shards.mjs"],
    ["an unknown top-level file", "website/api/report.js"],
  ])("runs everything for %s", (_label, file) => {
    expect(select([SPEC, file])).toBe("ALL");
  });

  it("runs everything when a dev-server script changes", () => {
    expect(select(["scripts/prepare-pdf-assets.mjs"], new Set(["scripts/prepare-pdf-assets.mjs"]))).toBe("ALL");
    expect(select(["scripts/prepare-pdf-assets.mjs"])).toEqual([]);
  });

  it("selects nothing for an empty diff", () => {
    expect(select([])).toEqual([]);
  });
});

describe("devServerScripts", () => {
  it("collects scripts named by vite.config.ts and package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-affected-"));
    try {
      writeFileSync(join(root, "vite.config.ts"), 'import { guard } from "./scripts/release-hook-leaks.mjs";');
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { dev: "node scripts/prepare-pdf-assets.mjs && vite dev" } }));

      expect([...devServerScripts(root)].sort()).toEqual(["scripts/prepare-pdf-assets.mjs", "scripts/release-hook-leaks.mjs"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tolerates missing files", () => {
    const root = mkdtempSync(join(tmpdir(), "e2e-affected-"));
    try {
      expect([...devServerScripts(root)]).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes the repository's dev-server inputs", () => {
    expect(devServerScripts().has("scripts/prepare-pdf-assets.mjs")).toBe(true);
  });
});
