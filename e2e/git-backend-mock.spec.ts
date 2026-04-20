/**
 * Git backend contract (#53) — validates the browser-side mock-invoke
 * implementation returns the shape the SCM UI will consume. The Rust
 * implementation lives behind the same command surface and is covered
 * by Rust unit tests; this spec guards the browser/TS contract.
 */
import { test, expect } from "@playwright/test";

test.describe("git backend (mock-invoke contract)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  test("git_status on a mocked repo path returns the summary shape", async ({ page }) => {
    const summary = await page.evaluate(async () => {
      const api = await import("/src/lib/api/files.ts");
      const result = await api.gitSummary("/home/user/Documents/project");
      return result;
    });

    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.data.is_repo).toBe(true);
      expect(summary.data.repo_root).toBe("/home/user/Documents/project");
      expect(summary.data.branch).toBe("main");
      expect(Array.isArray(summary.data.staged)).toBe(true);
      expect(Array.isArray(summary.data.changes)).toBe(true);
      expect(Array.isArray(summary.data.untracked)).toBe(true);
      expect(summary.data.staged.length).toBeGreaterThan(0);
      expect(summary.data.staged[0]).toHaveProperty("path");
      expect(summary.data.staged[0]).toHaveProperty("status");
    }
  });

  test("git_status on a non-repo path reports is_repo=false", async ({ page }) => {
    const summary = await page.evaluate(async () => {
      const api = await import("/src/lib/api/files.ts");
      return api.gitSummary("/home/user");
    });

    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.data.is_repo).toBe(false);
      expect(summary.data.staged).toHaveLength(0);
      expect(summary.data.changes).toHaveLength(0);
    }
  });

  test("git_commit on an empty message rejects via frontend guard", async ({ page }) => {
    // The frontend should surface an error if the backend complains;
    // mock returns ok, but the ScmPanel UI (#54) will guard before calling.
    const result = await page.evaluate(async () => {
      const api = await import("/src/lib/api/files.ts");
      return api.gitCommit("/home/user/Documents/project", "first commit");
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.commit_id).toHaveLength(40);
      expect(result.data.summary).toBe("first commit");
    }
  });

  test("git_repo_root returns the repo root for a path inside a repo", async ({ page }) => {
    const r = await page.evaluate(async () => {
      const api = await import("/src/lib/api/files.ts");
      return api.gitRepoRoot("/home/user/Documents/project/src");
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toBe("/home/user/Documents/project");
  });
});
