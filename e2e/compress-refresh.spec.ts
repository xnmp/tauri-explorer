/**
 * Regression: after "Compress to ZIP", the new archive must appear in the
 * listing WITHOUT a manual refresh.
 *
 * The bug: compressToZip calls markLocalMutation() (which starts the
 * mutation cooldown) and then refreshSilent() — but a silent refresh is
 * skipped during the cooldown, so the post-mutation refresh was swallowed
 * and the zip only showed up on a manual F5. Fixed by forcing the
 * post-mutation refresh past the cooldown.
 */

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test.describe("Compress to ZIP listing refresh", () => {
  test("the created .zip appears without a manual refresh", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    // No .zip in /home/user to start.
    const zipNames = page.locator(".entry-item .entry-name", { hasText: ".zip" });
    await expect(zipNames).toHaveCount(0);

    // Right-click a file → Compress to ZIP.
    const file = page.locator(".entry-item", { hasText: "readme.txt" }).first();
    await file.click();
    await file.click({ button: "right" });
    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await menu.getByText("Compress to ZIP").click();

    // The archive shows up on its own — no F5. (If the cooldown swallowed
    // the refresh, this never appears.)
    await expect(zipNames).toHaveCount(1, { timeout: 5000 });
  });
});
