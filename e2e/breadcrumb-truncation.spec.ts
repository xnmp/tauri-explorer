/**
 * E2E tests for breadcrumb truncation (p10k-style)
 * Verifies that long paths are truncated with "…" in the middle,
 * and validates pretext-calculated widths against actual DOM measurements.
 */

import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test.describe("Breadcrumb truncation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForEntries(page);
  });

  test("short paths show all segments without truncation @smoke", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);

    const ellipsis = page.locator(".breadcrumbs-container .crumb.ellipsis");
    await expect(ellipsis).toHaveCount(0);

    const crumbs = page.locator(".breadcrumbs-container .crumb:not(.root):not(.ellipsis)");
    await expect(crumbs.first()).toBeVisible();
  });

  test("deep paths show ellipsis when breadcrumbs overflow", async ({ page }) => {
    // Navigate to a deep path: Documents > project > src > components > Button
    await page.goto("/?path=/home/user/Documents/project/src/components/Button");
    await waitForEntries(page);

    // Shrink the window to force overflow
    await page.setViewportSize({ width: 600, height: 600 });
    await page.waitForTimeout(200);

    const ellipsis = page.locator(".breadcrumbs-container .crumb.ellipsis");
    await expect(ellipsis).toBeVisible();
    await expect(ellipsis).toHaveText("…");
  });

  test("first and last breadcrumb segments are always visible", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project/src/components/Button");
    await waitForEntries(page);

    await page.setViewportSize({ width: 600, height: 600 });
    await page.waitForTimeout(200);

    const crumbs = page.locator(".breadcrumbs-container .crumb:not(.ellipsis):not(.root)");
    const allTexts = await crumbs.allTextContents();

    // First visible segment should be "Documents" (first after home)
    expect(allTexts[0]).toBe("Documents");
    // Last visible segment should be "Button" (current directory)
    expect(allTexts[allTexts.length - 1]).toBe("Button");
  });

  test("wide window shows all segments without truncation", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project/src/components/Button");
    await waitForEntries(page);

    // Use a wide viewport — all segments should fit
    await page.setViewportSize({ width: 1400, height: 600 });
    await page.waitForTimeout(200);

    const ellipsis = page.locator(".breadcrumbs-container .crumb.ellipsis");
    await expect(ellipsis).toHaveCount(0);

    const crumbs = page.locator(".breadcrumbs-container .crumb:not(.root):not(.ellipsis)");
    const allTexts = await crumbs.allTextContents();
    expect(allTexts).toEqual(["Documents", "project", "src", "components", "Button"]);
  });

  test("canvas-calculated breadcrumb width matches measured DOM width within 5%", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project/src/components/Button");
    await waitForEntries(page);

    // Use a wide viewport so all segments render (no truncation)
    await page.setViewportSize({ width: 1400, height: 600 });
    await page.waitForTimeout(300);

    // Measure actual DOM widths and compare against canvas text measurement
    // using the same computed font the browser renders with
    const result = await page.evaluate(() => {
      const container = document.querySelector(".breadcrumbs-container") as HTMLElement;
      const crumbs = Array.from(container.querySelectorAll(".crumb:not(.root)")) as HTMLElement[];
      const separators = Array.from(container.querySelectorAll(".separator")) as HTMLElement[];

      // Measured DOM widths
      const measuredCrumbWidths = crumbs.map((el) => el.getBoundingClientRect().width);
      const measuredSepWidths = separators.map((el) => el.getBoundingClientRect().width);
      const measuredTotal = measuredCrumbWidths.reduce((s, w) => s + w, 0)
        + measuredSepWidths.reduce((s, w) => s + w, 0);

      // Canvas-calculated widths using the actual computed font from the element
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      const firstCrumb = crumbs[0];
      const style = getComputedStyle(firstCrumb);
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

      const names = crumbs.map((el) => el.textContent || "");
      const calculatedCrumbWidths = names.map((name) => {
        const textWidth = ctx.measureText(name).width;
        const elStyle = getComputedStyle(crumbs[names.indexOf(name)]);
        const padLeft = parseFloat(elStyle.paddingLeft);
        const padRight = parseFloat(elStyle.paddingRight);
        return textWidth + padLeft + padRight;
      });
      const calculatedSepWidths = separators.map((el) => {
        const s = getComputedStyle(el);
        const padLeft = parseFloat(s.paddingLeft);
        const padRight = parseFloat(s.paddingRight);
        const icon = el.querySelector("svg");
        const iconWidth = icon ? icon.getBoundingClientRect().width : 12;
        return padLeft + padRight + iconWidth;
      });

      const calculatedTotal = calculatedCrumbWidths.reduce((s, w) => s + w, 0)
        + calculatedSepWidths.reduce((s, w) => s + w, 0);

      return {
        measuredTotal,
        calculatedTotal,
        ratio: calculatedTotal / measuredTotal,
        names,
        measuredCrumbWidths,
        calculatedCrumbWidths,
        font: ctx.font,
      };
    });

    // Canvas calculation should be within 5% of DOM measurement
    expect(result.ratio).toBeGreaterThan(0.95);
    expect(result.ratio).toBeLessThan(1.05);
  });
});
