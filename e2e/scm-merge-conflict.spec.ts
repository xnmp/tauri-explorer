/**
 * SCM merge-conflict / in-progress operation flow (#294).
 *
 * Drives the stateful mock git backend through a real merge conflict and
 * asserts user-visible outcomes: the in-progress banner appears with a
 * conflict count, the commit control is blocked while conflicts remain,
 * resolving (staging) the conflict unblocks the commit and the commit lands,
 * and Abort clears the operation entirely.
 */
import { test, expect, type Page } from "./fixtures";

interface MockGitCommit {
  message: string;
  amend: boolean;
  files: string[];
  commit_id: string;
}

declare global {
  interface Window {
    __mockGitCommits?: MockGitCommit[];
    __mockGitReset?: () => void;
    __mockGitStartMergeConflict?: () => void;
  }
}

async function openScmOnRepo(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    const raw = localStorage.getItem("explorer-settings");
    const s = raw ? JSON.parse(raw) : {};
    s.showGitStatus = true;
    s.showScmPanel = true;
    localStorage.setItem("explorer-settings", JSON.stringify(s));
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();
  await page.locator('[data-section="staged"]').waitFor({ state: "visible" });
}

const banner = (page: Page) => page.locator(".op-banner");
const commitBtn = (page: Page) => page.getByRole("button", { name: /^Commit$/ });

test.describe("SCM merge-conflict handling", () => {
  test("shows an in-progress banner with the conflict count and blocks commit until resolved", async ({ page }) => {
    await openScmOnRepo(page);

    // No operation in progress initially.
    await expect(banner(page)).toHaveCount(0);

    // Enter a merge-conflict state.
    await page.evaluate(() => window.__mockGitStartMergeConflict?.());

    // Banner announces the merge with the conflicted-file count.
    await expect(banner(page)).toBeVisible();
    await expect(banner(page).locator(".op-banner-title")).toHaveText("Merge in progress");
    await expect(banner(page).locator(".op-banner-detail")).toContainText("1 conflicted file");

    // The conflicted file appears in the Merge Changes section.
    await expect(
      page.locator('[data-section="merge"] .row', { hasText: "constants.ts" }),
    ).toBeVisible();

    // Commit is blocked while the conflict is unresolved — even with a message.
    await page.getByLabel("Commit message").fill("resolve the merge");
    await expect(commitBtn(page)).toBeDisabled();

    // Resolve by staging the conflicted file.
    const mergeRow = page.locator('[data-section="merge"] .row', { hasText: "constants.ts" });
    await mergeRow.hover();
    await mergeRow.locator('.row-btn[title="Stage"]').click();

    // It moved into Staged; the merge section is now empty.
    await expect(
      page.locator('[data-section="staged"] .row', { hasText: "constants.ts" }),
    ).toBeVisible();
    await expect(page.locator('[data-section="merge"]')).toHaveCount(0);

    // Banner still shows (merge not committed yet) but now invites committing,
    // and the commit control is enabled.
    await expect(banner(page).locator(".op-banner-detail")).toContainText("commit to finish");
    await expect(commitBtn(page)).toBeEnabled();

    // Commit lands and clears the operation.
    await commitBtn(page).click();
    await expect(banner(page)).toHaveCount(0);
    const messages = await page.evaluate(() => window.__mockGitCommits?.map((c) => c.message) ?? []);
    expect(messages).toContain("resolve the merge");
  });

  test("Abort clears the in-progress operation and its conflicts", async ({ page }) => {
    await openScmOnRepo(page);
    await page.evaluate(() => window.__mockGitStartMergeConflict?.());
    await expect(banner(page)).toBeVisible();

    // Abort the merge.
    await banner(page).locator(".op-banner-btn.abort").click();

    // Banner and the merge section are gone; no commit was recorded.
    await expect(banner(page)).toHaveCount(0);
    await expect(page.locator('[data-section="merge"]')).toHaveCount(0);
    const count = await page.evaluate(() => window.__mockGitCommits?.length ?? 0);
    expect(count).toBe(0);
  });
});
