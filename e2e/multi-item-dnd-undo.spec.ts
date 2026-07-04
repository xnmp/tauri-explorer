/**
 * Multi-item drag-and-drop undo (#163): dropping N selected items is ONE
 * undoable operation — a single Ctrl+Z restores all of them.
 * (Synthetic HTML5 drag exercises the app's dragstart/drop handlers; it
 * does not validate OS-level DnD, which is fine for the undo semantics.)
 */
import { test, expect } from "@playwright/test";
import { waitForEntries } from "./helpers";

test("one Ctrl+Z reverts a multi-item drop", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  const entryCount = await page.locator(".entry-item").count();
  expect(entryCount).toBeGreaterThan(2);

  // Select everything and drag one selected file onto the project folder —
  // the drag carries the whole selection.
  await page.keyboard.press("Control+a");
  await page
    .locator(".entry-item")
    .filter({ hasText: "report.pdf" })
    .dragTo(page.locator(".entry-item").filter({ hasText: "project" }));

  // All files (everything except the target folder itself) moved as a batch.
  await expect(page.locator(".toast").first()).toContainText(
    `Moved ${entryCount - 1} items to project`,
  );
  await expect(page.locator(".entry-item")).toHaveCount(1);

  // ONE undo restores every moved item.
  await page.keyboard.press("Control+z");
  await expect(page.locator(".entry-item")).toHaveCount(entryCount);
});
