/**
 * The marquee band layers are sized to `.content`'s client box (#1051). A
 * horizontal scrollbar on `.content` (Details with the Resolution column
 * wider than a preview-docked pane) shrinks that box below the bounding
 * rect; a base taken from the bounding rect painted the fill short of the
 * bottom edge by the scrollbar's share of the band. Playwright's headless
 * Chromium hides scrollbars by default, so this spec launches its own
 * browser with classic scrollbars that take up space.
 */
import { test, expect } from "./fixtures";
import { waitForEntries, seedSettings, waitForStableWidth } from "./helpers";
import { dragAndVerifyBand } from "./marquee-band-verify";

test.use({
  launchOptions: {
    ignoreDefaultArgs: ["--hide-scrollbars"],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  },
});

test("details with a horizontal scrollbar: band layers follow the scrollbar-excluded box", async ({ page, browserName }) => {
  // The classic-scrollbar launch flag is Chromium's; other engines are
  // covered by the zoom cases in marquee-compositor-only.spec.ts.
  test.skip(browserName !== "chromium", "classic scrollbars are forced through a Chromium launch flag");
  await seedSettings(page, { showPreviewPane: true });
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto("/?path=/home/user/Pictures&viewMode=details");
  await waitForEntries(page);
  const scroller = page.locator(".file-list .content");
  await waitForStableWidth(scroller);
  const metrics = await scroller.evaluate((element) => ({
    horizontalScrollbar: element.scrollWidth > element.clientWidth,
    scrollbarHeight: element.getBoundingClientRect().height - element.clientHeight,
  }));
  expect(metrics.horizontalScrollbar).toBe(true);
  // Overlay scrollbars take no space; the scenario then has nothing to prove.
  test.skip(metrics.scrollbarHeight === 0, "overlay scrollbars leave the client box equal to the bounding box");
  await dragAndVerifyBand(page, { bottomInset: 20 });
});
