import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test("navigation highlights settle immediately and breadcrumbs still navigate", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);

  for (const selector of [".nav-btn:not(:disabled):not(.disabled)", ".crumb:not(.ellipsis)", ".caret-btn"]) {
    const control = page.locator(selector).first();
    await control.hover();
    const feedback = await control.evaluate((element) => {
      const style = getComputedStyle(element);
      const properties = style.transitionProperty.split(",").map((p) => p.trim());
      const durations = style.transitionDuration.split(",").map((d) => parseFloat(d));
      return {
        delayed: properties.some((p, i) =>
          ["all", "background", "background-color", "color"].includes(p) && durations[i % durations.length] > 0),
        running: element.getAnimations().filter((a) => a.playState === "running").length,
      };
    });
    expect(feedback, selector).toEqual({ delayed: false, running: 0 });
  }

  await page.getByRole("button", { name: "Home folder", exact: true }).click();
  await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();
  await page.screenshot({ path: "screenshots/refactor/repo-health-cleanup/navigation.png" });
});
