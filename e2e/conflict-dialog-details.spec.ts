/**
 * Conflict dialog behavior during paste.
 * Issue: feat/conflict-dialog-details
 *
 * notes.md exists in both /home/user and /home/user/Documents in the mock
 * filesystem, so copying it across triggers a real conflict.
 */
import { test, expect, type Page } from "@playwright/test";
import { HOME_URL, waitForEntries, pressShortcut, MULTI_SELECT_MODIFIER } from "./helpers";

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

  test("Replace overwrites the existing file — one entry, source content wins", async ({ page }) => {
    // Documents/notes.md is 4 KB; the pasted /home/user/notes.md is 2 KB.
    const notes = page.locator(".entry-item", { hasText: "notes.md" });
    await triggerConflict(page);
    // Sanity: the existing file shows its own (4 KB) size before we replace it.
    await expect(notes.locator(".size-cell")).toHaveText("4 KB");

    await page.locator(".conflict-dialog").getByRole("button", { name: "Replace", exact: true }).click();
    await expect(page.locator(".conflict-dialog")).toHaveCount(0);

    // Still exactly one notes.md, and it now carries the source's 2 KB size —
    // the destination entry was replaced, not duplicated.
    await expect(notes).toHaveCount(1);
    await expect(notes.locator(".size-cell")).toHaveText("2 KB");
  });

  test("Replace All resolves every conflict in one interaction", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Copy two files out of Documents.
    await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
    await expect(page.locator(".breadcrumbs-container")).toContainText("Documents");
    await waitForEntries(page);
    await page.locator(".entry-item", { hasText: "report.pdf" }).first().click();
    await page.locator(".entry-item", { hasText: "budget.xlsx" }).first().click({
      modifiers: [MULTI_SELECT_MODIFIER],
    });
    await expect(page.locator(".entry-item.selected")).toHaveCount(2);
    await pressShortcut(page, "c", { ctrlKey: true });
    await expect(page.locator(".toast.clipboard")).toBeVisible();

    // Go to the empty Archive folder and paste — no conflicts the first time.
    // (The home crumb collapses to an icon, so navigate up via the toolbar.)
    await page.getByRole("button", { name: "Go up one level" }).click();
    await waitForEntries(page);
    await page.locator(".entry-item", { hasText: "Archive" }).first().dblclick();
    await expect(page.locator(".breadcrumbs-container")).toContainText("Archive");
    await pressShortcut(page, "v", { ctrlKey: true });
    await expect(page.locator(".entry-item")).toHaveCount(2);

    // Paste again into the same folder — both names now conflict.
    await pressShortcut(page, "v", { ctrlKey: true });
    const dialog = page.locator(".conflict-dialog");
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // One "Replace All (2)" click clears BOTH conflicts — no second dialog.
    await dialog.getByRole("button", { name: /Replace All/ }).click();
    await expect(dialog).toHaveCount(0);

    // Archive still holds exactly the two files, replaced in place (no dupes,
    // no "- Copy" spawn).
    await expect(page.locator(".entry-item")).toHaveCount(2);
    await expect(page.locator(".entry-item", { hasText: "report.pdf" })).toHaveCount(1);
    await expect(page.locator(".entry-item", { hasText: "budget.xlsx" })).toHaveCount(1);
  });
});
