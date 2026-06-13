/**
 * Conflict dialog behavior during paste.
 * Issue: feat/conflict-dialog-details
 *
 * notes.md exists in both /home/user and /home/user/Documents in the mock
 * filesystem, so copying it across triggers a real conflict.
 */
import { test, expect, type Page } from "@playwright/test";
import { HOME_URL, waitForEntries, pressShortcut } from "./helpers";

async function triggerConflict(page: Page): Promise<void> {
  await page.goto(HOME_URL);
  await waitForEntries(page);

  // Copy /home/user/notes.md
  const file = page.locator(".entry-item", { hasText: "notes.md" }).first();
  await file.click();
  await pressShortcut(page, "c", { ctrlKey: true });
  await expect(page.locator(".toast.clipboard")).toBeVisible();

  // Paste into Documents, which already contains a notes.md
  await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
  await expect(page.locator(".breadcrumbs-container")).toContainText("Documents");
  await waitForEntries(page);
  await pressShortcut(page, "v", { ctrlKey: true });

  await expect(page.locator(".conflict-dialog")).toBeVisible({ timeout: 5000 });
}

test.describe("Conflict dialog", () => {
  test("pasting over an existing file shows the conflict with file details", async ({ page }) => {
    await triggerConflict(page);

    const dialog = page.locator(".conflict-dialog");
    await expect(dialog).toContainText("File already exists");
    await expect(dialog).toContainText("notes.md");

    // Detail rows for both sides (size/date from mock metadata).
    await expect(dialog.locator(".conflict-file", { hasText: "Source" })).toBeVisible();
    await expect(dialog.locator(".conflict-file", { hasText: "Existing" })).toBeVisible();

    await expect(dialog.getByRole("button", { name: "Replace", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Skip", exact: true })).toBeVisible();
  });

  test("backdrop click does not dismiss — a conflict needs an explicit choice", async ({ page }) => {
    await triggerConflict(page);

    await page.locator(".conflict-overlay").click({ position: { x: 5, y: 5 } });
    await expect(page.locator(".conflict-dialog")).toBeVisible();

    // Escape cancels the operation explicitly.
    await page.keyboard.press("Escape");
    await expect(page.locator(".conflict-dialog")).toHaveCount(0);

    // Nothing was overwritten or duplicated.
    await expect(page.locator(".entry-item", { hasText: "notes.md" })).toHaveCount(1);
  });

  test("Skip leaves the existing file untouched", async ({ page }) => {
    await triggerConflict(page);

    await page.locator(".conflict-dialog").getByRole("button", { name: "Skip", exact: true }).click();
    await expect(page.locator(".conflict-dialog")).toHaveCount(0);
    await expect(page.locator(".entry-item", { hasText: "notes.md" })).toHaveCount(1);
  });
});
