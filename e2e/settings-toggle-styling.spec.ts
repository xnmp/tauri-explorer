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

test("Premium Theme Effects toggle renders a complete, clearly selected switch", async ({ page }) => {
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

  const offStyle = await slider.evaluate((element) => {
    const track = getComputedStyle(element);
    const thumb = getComputedStyle(element, "::before");
    return {
      trackWidth: element.getBoundingClientRect().width,
      trackHeight: element.getBoundingClientRect().height,
      trackRadius: track.borderTopLeftRadius,
      trackColor: track.backgroundColor,
      thumbWidth: thumb.width,
      thumbHeight: thumb.height,
      thumbTop: thumb.top,
      thumbColor: thumb.backgroundColor,
    };
  });
  // Chromium can apply a fractional effective zoom in the test viewport;
  // accept that rounding while rejecting the pre-fix ~24px collapsed control.
  expect(offStyle.trackWidth).toBeGreaterThanOrEqual(43);
  expect(offStyle.trackHeight).toBeGreaterThanOrEqual(23);
  expect(offStyle.trackRadius).toBe("12px");
  expect(offStyle.thumbWidth).toBe("18px");
  expect(offStyle.thumbHeight).toBe("18px");
  expect(offStyle.thumbTop).toBe("2px");

  await row.locator("label.toggle").click();
  await expect(input).toBeChecked();
  await expect
    .poll(() =>
      slider.evaluate((element) => {
        const track = getComputedStyle(element);
        const thumb = getComputedStyle(element, "::before");
        return { trackColor: track.backgroundColor, thumbColor: thumb.backgroundColor };
      }),
    )
    .not.toEqual({ trackColor: offStyle.trackColor, thumbColor: offStyle.thumbColor });
  await page.screenshot({ path: shot("ac-1-settings-toggle-styling.png") });
});
