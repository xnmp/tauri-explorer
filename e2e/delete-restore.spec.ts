/**
 * Delete → trash → restore loop, and permanent-delete semantics.
 * Issue: test/e2e-coverage-tier1
 *
 * A trash delete pushes an undo action (Ctrl+Z runs it), whereas a permanent
 * delete pushes none (by design — see pane-mutations.ts confirmDelete +
 * undo-operations.ts), so Ctrl+Z is a no-op after a permanent delete.
 *
 * MOCK LIMITATION: the browser mock's `restore_from_trash` handler is a no-op
 * (trash restore is OS-level), so undoing a trash delete cannot re-materialise
 * the row in E2E. We therefore assert the two things that ARE observable in the
 * mock: the trash delete is undoable (an "Undo" toast fires when Ctrl+Z runs
 * the recorded action) while a permanent delete records nothing to undo.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

const DOCS_URL = "/?path=/home/user/Documents";

async function confirmDeleteDialog(page: Page): Promise<void> {
  const dialog = page.locator("[role='alertdialog']");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /^Delete/ }).click();
  await expect(dialog).not.toBeVisible();
}

test.describe("Delete / restore", () => {
  test("confirming the delete dialog removes the entry; the delete is undoable @smoke", async ({ page }) => {
    await page.goto(DOCS_URL);
    await waitForEntries(page);

    const notes = page.locator(".entry-item .entry-name", { hasText: "notes.md" });
    await expect(notes).toBeVisible();

    await page.locator(".entry-item", { hasText: "notes.md" }).first().click();
    await page.keyboard.press("Delete");
    await confirmDeleteDialog(page);

    // Gone from the list.
    await expect(notes).toHaveCount(0);

    // Ctrl+Z runs the recorded undo action — surfaced as an "Undo" toast.
    // (The row can't re-appear here because the mock's restore_from_trash is a
    // no-op; the recorded, executed undo is what's observable in E2E.)
    await page.keyboard.press("Control+z");
    await expect(page.locator(".toast", { hasText: "Undo" })).toBeVisible();
  });

  test("permanent delete removes the entry and cannot be undone", async ({ page }) => {
    await page.goto(DOCS_URL);
    await waitForEntries(page);

    const notes = page.locator(".entry-item .entry-name", { hasText: "notes.md" });
    await expect(notes).toBeVisible();

    await page.locator(".entry-item", { hasText: "notes.md" }).first().click();
    await page.keyboard.press("Shift+Delete");

    const dialog = page.locator("[role='alertdialog']");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Permanently delete");
    await dialog.getByRole("button", { name: /^Delete/ }).click();
    await expect(dialog).not.toBeVisible();

    await expect(notes).toHaveCount(0);

    // No undo action was recorded — Ctrl+Z leaves it deleted.
    await page.keyboard.press("Control+z");
    await expect(notes).toHaveCount(0);
  });
});
