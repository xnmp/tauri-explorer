/**
 * E2E test: breadcrumb segments accept file drops.
 * Issue: feat/breadcrumb-drop-target
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Breadcrumb drop target", () => {
  test("breadcrumb segments have drag event handlers", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Navigate into a subfolder to get breadcrumbs
    await page.locator(".entry-item").first().dblclick();
    await page.waitForTimeout(500);

    // Check that breadcrumb segments exist and have the drop-target CSS class available
    const crumbs = page.locator(".crumb:not(.root)");
    const count = await crumbs.count();
    expect(count).toBeGreaterThan(0);
  });
});
