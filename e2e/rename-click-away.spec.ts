/**
 * E2E test: clicking another file while a rename box is open must close the
 * rename (commit) and select the clicked file — it should not leave the box
 * stuck open.
 * Issue: feat/rename-box (click-away closes rename)
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Rename click-away", () => {
  test("clicking another file closes the rename box", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    const items = page.locator(".entry-item");

    // Start renaming the first item.
    await items.first().click();
    await page.keyboard.press("F2");
    await page.locator(".rename-input").waitFor({ state: "visible", timeout: 2000 });

    // Click a different file — the rename box must close.
    await items.nth(1).click();
    await expect(page.locator(".rename-input")).toHaveCount(0);
  });
});
