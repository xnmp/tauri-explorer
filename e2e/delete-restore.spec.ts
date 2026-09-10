/**
 * Delete → trash → restore loop, and permanent-delete semantics.
 * Issue: test/e2e-coverage-tier1
 *
 * A trash delete pushes an undo action (Ctrl+Z runs it), whereas a permanent
 * delete pushes none, so Ctrl+Z is a no-op after a permanent delete.
 *
 * Browser fixtures retain trashed entries so restore asserts the visible file
 * outcome. Real native trash receipts are covered separately.
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

    // Undo restores the actual fixture entry, then redo removes it again.
    await page.keyboard.press("Control+z");
    await expect(notes).toBeVisible();
    await page.keyboard.press("Control+Shift+z");
    await expect(notes).toHaveCount(0);
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

test("partial delete keeps the successful local item undoable", async ({ page }) => {
  await page.goto(DOCS_URL);
  await waitForEntries(page);
  await page.evaluate(async () => {
    const modulePath = "/src/lib/state/window-tabs.svelte.ts";
    const { windowTabsManager } = await import(/* @vite-ignore */ modulePath);
    const explorer = windowTabsManager.getActiveExplorer();
    const local = explorer.displayEntries.find((entry: { name: string }) => entry.name === "notes.md");
    explorer.startDelete([local, { ...local, name: "network.txt", path: "//server/share/network.txt" }]);
  });
  // The browser fixture pins Linux: double-slash paths are local here.
  await expect(page.getByRole("alertdialog")).toContainText("These 2 items will be moved to the Recycle Bin");
  await confirmDeleteDialog(page);
  const notes = page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]');
  await expect(notes).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(notes).toBeVisible();
});


test("Linux double-slash local path does not warn of permanent network deletion", async ({ page }) => {
  await page.goto(DOCS_URL);
  await waitForEntries(page);
  await page.evaluate(async () => {
    const modulePath = "/src/lib/state/window-tabs.svelte.ts";
    const { windowTabsManager } = await import(/* @vite-ignore */ modulePath);
    const explorer = windowTabsManager.getActiveExplorer();
    const local = explorer.displayEntries.find((entry: { name: string }) => entry.name === "notes.md");
    explorer.startDelete([{ ...local, path: "//local/directory/item.txt" }]);
  });
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("moved to the Recycle Bin");
  await expect(dialog).not.toContainText("permanently");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]')).toBeVisible();
});
