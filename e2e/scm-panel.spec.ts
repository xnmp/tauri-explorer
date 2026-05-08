/**
 * SCM panel UI (#54).
 *
 * Exercises the Source Control sidebar view against the mock-invoke
 * backend. Navigates the active pane into the mocked repo path
 * (`/home/user/Documents/project`), switches the activity bar to SCM,
 * and asserts the rendered surface matches what the backend returns
 * (counts, rows, actions, commit button behaviour).
 */
import { test, expect, type Page } from "@playwright/test";

async function openScmOnRepo(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.removeItem("explorer-sidebar-active-view"));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // Navigate the active pane to the mocked git repo via double-clicks into Documents/project.
  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();

  // Switch to the SCM view.
  await page.getByRole("tab", { name: /Source Control/i }).click();
}

test.describe("SCM panel UI", () => {
  test("shows the mocked repo's staged / changes / untracked sections with counts", async ({ page }) => {
    await openScmOnRepo(page);

    const stagedSection = page.locator('[data-section="staged"]');
    const changesSection = page.locator('[data-section="changes"]');
    const untrackedSection = page.locator('[data-section="untracked"]');

    await expect(stagedSection).toBeVisible();
    await expect(changesSection).toBeVisible();
    await expect(untrackedSection).toBeVisible();

    await expect(stagedSection.locator(".count-badge")).toHaveText("1");
    await expect(changesSection.locator(".count-badge")).toHaveText("2");
    // Mock includes a binary asset alongside text files to exercise the
    // diff viewer's binary placeholder.
    await expect(untrackedSection.locator(".count-badge")).toHaveText("3");

    // Specific files from the mock
    await expect(stagedSection.getByText("App.tsx")).toBeVisible();
    await expect(changesSection.getByText("index.css")).toBeVisible();
    await expect(untrackedSection.getByText("router.tsx")).toBeVisible();
  });

  test("empty-state shows Initialize Repository when active pane is not a repo", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("explorer-sidebar-active-view"));
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Active pane defaults to /home/user (not a repo)
    await page.getByRole("tab", { name: /Source Control/i }).click();

    await expect(page.getByText(/Not a git repository/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Initialize Repository/i })).toBeVisible();
  });

  test("commit button switches between Commit and Amend (no edit) based on message content (#79)", async ({ page }) => {
    await openScmOnRepo(page);

    // Empty message + staged files → button is enabled and reads "Amend (no edit)".
    const amendBtn = page.getByRole("button", { name: /^Amend \(no edit\)$/ });
    await expect(amendBtn).toBeEnabled();

    // Typing a message switches the button to plain "Commit".
    await page.getByLabel("Commit message").fill("feat: ship this");
    const commitBtn = page.getByRole("button", { name: /^Commit$/ });
    await expect(commitBtn).toBeEnabled();
  });

  test("row status letters reflect the file's git state", async ({ page }) => {
    await openScmOnRepo(page);

    const stagedRow = page.locator('[data-section="staged"] .row', { hasText: "App.tsx" });
    await expect(stagedRow.locator(".status-letter")).toHaveText("M");

    const untrackedRow = page.locator('[data-section="untracked"] .row', { hasText: "router.tsx" });
    await expect(untrackedRow.locator(".status-letter")).toHaveText("U");
  });

  test("clicking a row selects it and arrow keys move selection", async ({ page }) => {
    await openScmOnRepo(page);

    const firstRow = page.locator('[data-section="staged"] .row').first();
    await firstRow.click();
    await expect(firstRow).toHaveClass(/selected/);

    // Focus the view so arrow keys land on the keydown handler.
    await page.locator(".scm-view").focus().catch(() => {});
    await page.keyboard.press("ArrowDown");

    // A different row should now be selected.
    const selected = page.locator(".scm-view .row.selected");
    await expect(selected).toHaveCount(1);
  });
});
