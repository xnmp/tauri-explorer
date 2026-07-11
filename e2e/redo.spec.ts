/**
 * Redo (Ctrl+Y) re-applies an undone operation.
 * Issue: test/e2e-coverage-tier1
 *
 * Rename is fully round-trippable in the browser mock: undo reverts the name,
 * redo re-applies it.
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForEntries } from "./helpers";

const DOCS_URL = "/?path=/home/user/Documents";

async function renameFile(page: Page, from: string, to: string): Promise<void> {
  await page.locator(".entry-item", { hasText: from }).first().click();
  await page.keyboard.press("F2");
  const input = page.locator(".rename-input");
  await expect(input).toBeFocused();
  await input.fill(to);
  await page.keyboard.press("Enter");
  await expect(input).not.toBeVisible({ timeout: 2000 });
}

test.describe("Redo", () => {
  test("Ctrl+Y re-applies an undone rename", async ({ page }) => {
    await page.goto(DOCS_URL);
    await waitForEntries(page);

    await renameFile(page, "notes.md", "renamed.md");
    await expect(page.locator(".entry-item .entry-name", { hasText: "renamed.md" })).toBeVisible();

    // Undo — the original name comes back.
    await page.keyboard.press("Control+z");
    await expect(page.locator(".entry-item .entry-name", { hasText: "notes.md" })).toBeVisible();
    await expect(page.locator(".entry-item .entry-name", { hasText: "renamed.md" })).toHaveCount(0);

    // Redo — the new name returns.
    await page.keyboard.press("Control+y");
    await expect(page.locator(".entry-item .entry-name", { hasText: "renamed.md" })).toBeVisible();
    await expect(page.locator(".entry-item .entry-name", { hasText: "notes.md" })).toHaveCount(0);
  });
});
