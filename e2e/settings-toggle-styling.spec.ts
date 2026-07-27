/**
 * Visual regression coverage for the shared Settings toggle control (#509).
 *
 * The browser owns pseudo-element layout, so assert the computed geometry at
 * the rendered settings seam rather than only checking the Svelte stylesheet.
 */
import { expect, test } from "./fixtures";
import { waitForEntries } from "./helpers";

const shot = (name: string) =>
  process.env.CAPTURE_EVIDENCE ? `evidence/${name}` : `test-results/evidence/${name}`;

test("Premium Theme Effects toggle keeps its thumb vertically centered", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await waitForEntries(page);

  await page.keyboard.press("Control+,");
  const search = page.locator(".settings-search");
  await expect(search).toBeVisible();
  await search.fill("Premium Theme Effects");

  const row = page.locator(".setting-row", {
    has: page.locator(".setting-label", { hasText: /^Premium Theme Effects$/ }),
  });
  const slider = row.locator(".toggle-slider");
  const input = row.locator('input[type="checkbox"]');
  await expect(slider).toBeVisible();
  await expect(input).not.toBeChecked();

  const toggleWidth = await slider.evaluate((element) => element.getBoundingClientRect().width);
  expect(toggleWidth).toBe(44);

  await row.locator("label.toggle").click();
  await expect(input).toBeChecked();
  await page.screenshot({ path: shot("ac-1-settings-toggle-styling.png") });
});
