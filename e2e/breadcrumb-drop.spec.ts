/** Browser/mock outcome coverage for breadcrumb drops; GTK source delivery is
 * verified separately by the native file-drag regression. */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

for (const mode of ["details", "list", "tiles"] as const) {
  test(`dropping a file on an ancestor breadcrumb moves it into that folder (${mode})`, async ({ page }) => {
    await page.goto(`/?path=/home/user/Pictures/vacation&viewMode=${mode}`);
    await waitForEntries(page);
    const source = page.locator('.entry-item[data-path="/home/user/Pictures/vacation/itinerary.txt"]');
    const destination = page.locator('.crumb[data-path="/home/user/Pictures"]');
    await source.dragTo(destination);
    await expect(page.locator(".toast").filter({ hasText: /Moved/ })).toHaveCount(1);
    await expect(source).toHaveCount(0);
    await destination.click();
    await expect(page.locator('.entry-item[data-path="/home/user/Pictures/itinerary.txt"]')).toBeVisible();
  });
}
