/** Regression coverage for #678: moving into an empty folder clears its cue. */
import { test, expect } from "./fixtures";
import { ALL_VIEW_MODES, waitForEntries, switchViewMode } from "./helpers";

function entry(page: import("@playwright/test").Page, name: string) {
  return page.locator(".entry-item", { hasText: name }).first();
}

test("moving a file into an empty folder clears its marker in every directory view", async ({ page }) => {
  await page.goto("/?path=/home/user");
  await waitForEntries(page);

  const archive = entry(page, "Archive");
  await expect(archive).toHaveClass(/empty-folder/);

  await entry(page, "readme.txt").dragTo(archive);
  await expect(archive).not.toHaveClass(/empty-folder/);
  await page.screenshot({ path: "evidence/ac-1-moved-folder-details.png" });

  for (const mode of ALL_VIEW_MODES.slice(1)) {
    await switchViewMode(page, mode);
    await expect(entry(page, "Archive")).not.toHaveClass(/empty-folder/);
    await page.screenshot({ path: `evidence/ac-2-moved-folder-${mode}.png` });
  }
});
