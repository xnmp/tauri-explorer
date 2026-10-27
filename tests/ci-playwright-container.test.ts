import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The browser jobs run inside Microsoft's Playwright image instead of
// installing browsers and apt packages per shard (#1367). Its browsers are
// built for exactly one Playwright release, so the tag must equal the
// @playwright/test version bun.lock resolves; a drifted pin fails every spec
// at launch ("Executable doesn't exist").
const lock = readFileSync(new URL("../bun.lock", import.meta.url), "utf8");
const ci = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const BROWSER_JOBS = ["chromium", "chromium-view-modes", "webkit-tests"];

/** The resolved version in bun.lock's text format: "@playwright/test": ["@playwright/test@X", ...]. */
function lockedVersion(name: string) {
  const escaped = name.replace(/[/.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*"${escaped}": \\["${escaped}@([^"]+)"`, "m").exec(lock);
  if (!match) throw new Error(`${name} is not resolved in bun.lock`);
  return match[1];
}

describe("Playwright container pin", () => {
  const version = lockedVersion("@playwright/test");

  it("reads an exact version from bun.lock", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lockedVersion("playwright-core")).toBe(version);
  });

  it("lists every job that runs Playwright", () => {
    const runsPlaywright = Object.entries(ci.jobs as Record<string, { steps?: { run?: string }[] }>)
      .filter(([, job]) => (job.steps ?? []).some((s) => s.run?.includes("--task ci:e2e")))
      .map(([id]) => id)
      .sort();
    expect(runsPlaywright).toEqual([...BROWSER_JOBS].sort());
  });

  const IMAGE = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:([0-9a-f]{64})$/;

  it.each(BROWSER_JOBS)("runs %s in the digest-pinned image for bun.lock's Playwright version", (id) => {
    const job = ci.jobs[id];
    const [, tagVersion, digest] = IMAGE.exec(job.container.image) ?? [];
    expect(tagVersion).toBe(version);
    // The test-result cache's platform identity names the container, digest included.
    expect(job.env.ImageOS).toBe("playwright_noble");
    expect(job.env.ImageVersion).toBe(`${version}_${digest}`);
  });

  it("pins one image across every browser job", () => {
    expect(new Set(BROWSER_JOBS.map((id) => ci.jobs[id].container.image)).size).toBe(1);
  });

  // The nightly coverage run that builds the test-impact map (#1368) must
  // execute the browsers the PR shards run.
  it("runs the impact-map coverage job in the same image and container bun", () => {
    const impact = parse(readFileSync(new URL("../.github/workflows/e2e-impact-map.yml", import.meta.url), "utf8"));
    expect(impact.jobs.coverage.container.image).toBe(ci.jobs.chromium.container.image);
    expect(String(impact.env.CONTAINER_BUN_VERSION)).toBe(String(ci.env.CONTAINER_BUN_VERSION));
  });

  describe("container bun", () => {
    const pinned = String(ci.env.CONTAINER_BUN_VERSION);

    it("is one exact version from the workflow env", () => {
      expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it.each(BROWSER_JOBS)("installs and verifies that version in %s, without install scripts", (id) => {
      const install = (ci.jobs[id].steps as { name?: string; run?: string }[]).find((s) => s.name === "Install bun");
      const run = install?.run ?? "";
      expect(run).toContain('npm install --global --ignore-scripts "@oven/bun-linux-x64@${CONTAINER_BUN_VERSION}"');
      expect(run).toContain('test "$(bun --version)" = "$CONTAINER_BUN_VERSION"');
      expect(run).not.toMatch(/bun@latest|@oven\/bun-linux-x64@\d/);
    });
  });

  it.each(BROWSER_JOBS)("never installs browsers or system packages in %s", (id) => {
    for (const step of ci.jobs[id].steps as { run?: string }[]) {
      expect(step.run ?? "").not.toMatch(/playwright install|apt-get|install-deps/);
    }
  });

  it.each(BROWSER_JOBS)("bounds %s's test step below the job cap and Playwright's run below that", (id) => {
    const job = ci.jobs[id];
    const run = (job.steps as { id?: string; "timeout-minutes"?: number }[]).find((s) => s.id === "test-cache-run");
    const global = Number(job.env.E2E_GLOBAL_TIMEOUT_MINUTES);
    expect(global).toBeGreaterThan(0);
    expect(run?.["timeout-minutes"]).toBeGreaterThan(global);
    expect(job["timeout-minutes"]).toBeGreaterThan(run?.["timeout-minutes"] as number);
  });

  it("passes the global timeout to Playwright", () => {
    const script = readFileSync(new URL("../scripts/ci-test-e2e.sh", import.meta.url), "utf8");
    expect(script).toContain('--global-timeout=$((E2E_GLOBAL_TIMEOUT_MINUTES * 60000))');
  });
});
