import { test, expect } from "./fixtures";
import { seedSettings } from "./helpers";

// #1644: Details column headers show a hairline separator at each column
// boundary, centred in the resize hit area so it marks where dragging resizes.
test("details headers draw a visible hairline at every column boundary", async ({ page }) => {
  await seedSettings(page, { zoomLevel: 100 }, { replace: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?path=/home/user/Documents&viewMode=details");
  await expect(page.locator(".details-view .entry-item").first()).toBeVisible();

  const separators = await page.locator(".pane-tree:not(.retained) .column-resize-handle").evaluateAll(handles =>
    handles.map(handle => {
      const line = getComputedStyle(handle, "::after");
      const header = getComputedStyle(handle.closest(".column-headers")!);
      const box = handle.getBoundingClientRect();
      return {
        content: line.content,
        width: line.width,
        color: line.backgroundColor,
        headerColor: header.backgroundColor,
        handleWidth: box.width,
        headerHeight: handle.closest(".column-headers")!.getBoundingClientRect().height,
        lineHeight: parseFloat(line.height),
      };
    }));

  expect(separators.length).toBeGreaterThanOrEqual(3);
  for (const separator of separators) {
    expect(separator.content).toBe('""');
    expect(separator.width).toBe("1px");
    expect(separator.color).not.toBe("rgba(0, 0, 0, 0)");
    expect(separator.color).not.toBe(separator.headerColor);
    expect(separator.lineHeight).toBeGreaterThan(0);
    expect(separator.lineHeight).toBeLessThan(separator.headerHeight);
  }

  await page.locator(".column-headers").first().screenshot({ path: "screenshots/fix/hairline-column-separators/headers.png" });
});
