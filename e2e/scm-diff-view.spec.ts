/**
 * Inline diff viewer (#55).
 *
 * Clicking a file in the SCM panel replaces the file list in the active
 * pane with a unified-diff view. Escape + Back button return to the file
 * list. Binary files show a placeholder.
 */
import { test, expect, type Page } from "@playwright/test";

async function openScmOnRepo(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("explorer-sidebar-active-view"));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // Walk the pane: /home → /home/user → Documents → project.
  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();

  await page.getByRole("tab", { name: /Source Control/i }).click();
  await page.locator('[data-section="staged"]').waitFor({ state: "visible" });
}

test.describe("SCM inline diff viewer", () => {
  test("clicking a staged row replaces the file list with the diff view", async ({ page }) => {
    await openScmOnRepo(page);

    // The pane starts with the file list visible.
    await expect(page.locator(".diff-view")).toHaveCount(0);

    await page.locator('[data-section="staged"] .row', { hasText: "App.tsx" }).click();

    const diffView = page.locator(".diff-view");
    await expect(diffView).toBeVisible();
    await expect(diffView.getByText("App.tsx")).toBeVisible();
    await expect(diffView.locator(".badge.staged")).toBeVisible();
    // Mock diff contains at least one add + one remove line.
    await expect(diffView.locator(".line.add").first()).toBeVisible();
    await expect(diffView.locator(".line.remove").first()).toBeVisible();
  });

  test("escape returns to the file list", async ({ page }) => {
    await openScmOnRepo(page);

    await page.locator('[data-section="changes"] .row', { hasText: "index.css" }).click();
    await expect(page.locator(".diff-view")).toBeVisible();

    await page.locator(".diff-view").focus();
    await page.keyboard.press("Escape");

    await expect(page.locator(".diff-view")).toHaveCount(0);
  });

  test("Back button returns to the file list", async ({ page }) => {
    await openScmOnRepo(page);

    await page.locator('[data-section="changes"] .row', { hasText: "README.md" }).click();
    await expect(page.locator(".diff-view")).toBeVisible();

    await page.getByRole("button", { name: /Back to file list/i }).click();
    await expect(page.locator(".diff-view")).toHaveCount(0);
  });

  test("unstaged rows open with unstaged badge and stage/discard actions", async ({ page }) => {
    await openScmOnRepo(page);

    await page.locator('[data-section="changes"] .row', { hasText: "index.css" }).click();

    const diffView = page.locator(".diff-view");
    await expect(diffView.locator(".badge.unstaged")).toBeVisible();
    await expect(diffView.getByRole("button", { name: /^Stage$/ })).toBeVisible();
    await expect(diffView.getByRole("button", { name: /^Discard$/ })).toBeVisible();
    await expect(diffView.getByRole("button", { name: /^Open File$/ })).toBeVisible();
  });

  test("switching files updates the diff without requiring a close", async ({ page }) => {
    await openScmOnRepo(page);

    await page.locator('[data-section="staged"] .row', { hasText: "App.tsx" }).click();
    await expect(page.locator(".diff-view").getByText("App.tsx")).toBeVisible();

    await page.locator('[data-section="changes"] .row', { hasText: "README.md" }).click();
    await expect(page.locator(".diff-view").getByText("README.md")).toBeVisible();
  });
});
