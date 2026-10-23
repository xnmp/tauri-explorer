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

  it.each(BROWSER_JOBS)("runs %s in the image for bun.lock's Playwright version", (id) => {
    const job = ci.jobs[id];
    expect(job.container.image).toBe(`mcr.microsoft.com/playwright:v${version}-noble`);
    // The test-result cache's platform identity names the container.
    expect(job.env.ImageOS).toBe("playwright_noble");
    expect(job.env.ImageVersion).toBe(version);
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
