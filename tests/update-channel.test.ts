/**
 * Version reset (#1783): 1.x installs compare plain versions against
 * `releases/latest`, so GitHub's "Latest" must stay on a release they see as
 * newer (the v1.28.2 bridge), while the bridge and later builds follow the
 * update-channel manifest in release order.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CHANNEL_TAG, channelProblem, isReleasedAfter, marksGitHubLatest } from "../scripts/update-channel.mjs";

describe("release order (mirrors release_order.rs)", () => {
  it("puts the alpha line after every 1.x release", () => {
    expect(isReleasedAfter("0.28.0", "1.28.2")).toBe(true);
    expect(isReleasedAfter("1.28.2", "0.28.0")).toBe(false);
    expect(isReleasedAfter("1.0.0", "0.9.0")).toBe(true);
    expect(isReleasedAfter("0.28.1", "0.28.0")).toBe(true);
    expect(isReleasedAfter("0.29.0", "0.28.9")).toBe(true);
    expect(isReleasedAfter("1.29.0", "0.99.0")).toBe(true);
    expect(isReleasedAfter("v2.0.0", "0.28.5")).toBe(true);
  });

  it("orders a pre-release before its release and treats equal releases as not newer", () => {
    expect(isReleasedAfter("0.29.0", "0.29.0-rc.1")).toBe(true);
    expect(isReleasedAfter("0.29.0-rc.1", "0.29.0")).toBe(false);
    expect(isReleasedAfter("0.28.0", "0.28.0")).toBe(false);
    expect(isReleasedAfter("0.29.0+build", "0.29.0")).toBe(false);
  });

  it("rejects anything but SemVer", () => {
    expect(() => isReleasedAfter("latest", "0.28.0")).toThrow(/SemVer/);
    expect(() => isReleasedAfter("0.28", "0.28.0")).toThrow(/SemVer/);
  });
});

describe("GitHub Latest", () => {
  it("stays on releases every 1.x install sees as newer", () => {
    expect(marksGitHubLatest("v1.28.2")).toBe(true);
    expect(marksGitHubLatest("v0.28.0")).toBe(false);
    expect(marksGitHubLatest("v0.99.3")).toBe(false);
    expect(marksGitHubLatest("v1.29.0")).toBe(true);
    expect(marksGitHubLatest("v2.0.0-rc.1")).toBe(false);
  });
});

describe("update channel", () => {
  it("accepts the first manifest and every later release", () => {
    expect(channelProblem("v1.28.2", undefined)).toBeNull();
    expect(channelProblem("v0.28.0", { version: "1.28.2" })).toBeNull();
    expect(channelProblem("v0.28.1", { version: "0.28.0" })).toBeNull();
  });

  it("allows the same release again, for a re-run after a failed upload", () => {
    expect(channelProblem("v0.28.0", { version: "0.28.0" })).toBeNull();
  });

  it("refuses to move the channel back, or to carry a pre-release", () => {
    expect(channelProblem("v1.28.3", { version: "0.28.0" })).toMatch(/not released after the channel's 0.28.0/);
    expect(channelProblem("v0.28.0", { version: "0.28.1" })).toMatch(/not released after/);
    expect(channelProblem("v0.28.0", {})).toMatch(/no version/);
    expect(channelProblem("v0.29.0-rc.1", { version: "0.28.0" })).toMatch(/pre-release/);
    expect(channelProblem("v0.29.0-rc.1", undefined)).toMatch(/pre-release/);
  });
});

describe("release.yml", () => {
  const release = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  const steps: { name?: string; run?: string }[] = release.jobs.release.steps;
  const run = (name: string) => {
    const step = steps.find((s) => s.name === name);
    expect(step, name).toBeDefined();
    return step?.run ?? "";
  };

  it("runs one release at a time", () => {
    expect(release.concurrency).toEqual({ group: "release", "cancel-in-progress": false });
  });

  it("checks the channel before publishing anything, and uploads to it last", () => {
    const names = steps.map((s) => s.name);
    const check = names.indexOf("Check the update channel");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(names.indexOf("Create release"));
    expect(names.indexOf("Publish to the update channel")).toBe(names.length - 1);
    const checkRun = run("Check the update channel");
    expect(checkRun).toContain(`channel=${CHANNEL_TAG}`);
    expect(checkRun).toMatch(/gh release create "\$channel" --prerelease --latest=false/);
    expect(checkRun).toMatch(/update-channel\.mjs check --version "\$VERSION"/);
    expect(run("Publish to the update channel")).toBe(`gh release upload ${CHANNEL_TAG} latest-alpha.json --clobber`);
  });

  it("marks only the planned releases Latest and gives only them latest.json", () => {
    const create = run("Create release");
    expect(create).toContain('latest=$(node scripts/update-channel.mjs github-latest "$VERSION")');
    expect(create).toMatch(/if \[\[ \$latest == true \]\]; then\s+cp latest-alpha\.json latest\.json\s+assets\+=\(latest\.json\)/);
    expect(create).toMatch(/--latest="\$latest"/);
    expect(create).toContain("assets+=(latest-alpha.json)");
  });

  it("lets a re-run continue past an already published release", () => {
    const create = run("Create release");
    expect(create.indexOf('gh release view "$VERSION"')).toBeLessThan(create.indexOf('gh release create "$VERSION"'));
    expect(create).toMatch(/already published[^\n]*\n\s*exit 0/);
  });

  it("matches the endpoint installed apps read", () => {
    const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    expect(config.plugins.updater.endpoints).toEqual([
      `https://github.com/xnmp/tauri-explorer/releases/download/${CHANNEL_TAG}/latest-alpha.json`,
    ]);
  });
});
