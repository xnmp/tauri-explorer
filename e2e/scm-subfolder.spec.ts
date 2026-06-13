/**
 * E2E test: SCM panel shows repo status when navigated into a subfolder.
 * Issue: fix trailing-slash mismatch in filterToDir that caused empty SCM
 * panel when activePath was inside a repo subdirectory.
 */
import { test, expect, type Page } from "@playwright/test";

async function openScmInSubfolder(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
    s.showGitStatus = true;
    s.showScmPanel = true;
    localStorage.setItem("explorer-settings", JSON.stringify(s));
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

  // Navigate: home → Documents → project (repo root) → src (subfolder)
  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  await page.getByText("project", { exact: true }).first().dblclick();
  await page.locator('[data-section="staged"]').waitFor({ state: "visible", timeout: 5000 });

  // Now navigate into the src subfolder within the file list pane
  const srcEntry = page.locator('.file-list .entry-item.directory', { hasText: "src" });
  await srcEntry.waitFor({ timeout: 5000 });
  await srcEntry.dblclick();
  await page.waitForTimeout(500);
}

test.describe("SCM panel in repo subfolder", () => {
  test("shows changes when navigated into a subfolder of the repo", async ({ page }) => {
    await openScmInSubfolder(page);

    // The changes section should show src/index.css (which is under src/)
    const changesSection = page.locator('[data-section="changes"]');
    await expect(changesSection).toBeVisible();

    const changesRows = changesSection.locator(".row");
    const count = await changesRows.count();
    expect(count).toBeGreaterThan(0);
  });

  test("does not show 'Working tree clean' when repo has changes in current subfolder", async ({ page }) => {
    await openScmInSubfolder(page);

    await expect(page.locator(".clean-state")).toHaveCount(0);
  });

  test("staged section shows entries from current subfolder", async ({ page }) => {
    await openScmInSubfolder(page);

    // src/App.tsx is staged and lives under src/
    const stagedSection = page.locator('[data-section="staged"]');
    await expect(stagedSection.locator(".row", { hasText: "App.tsx" })).toBeVisible();
  });
});
