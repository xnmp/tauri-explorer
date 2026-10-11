import { test, expect } from "./fixtures";
import { focusBeforeFileList, seedSettings } from "./helpers";

test("wide Details rows keep the leading keyboard focus ring inside the pane", async ({ page }) => {
  await seedSettings(page, { theme: "light", showPreviewPane: true });
  await page.setViewportSize({ width: 1240, height: 900 });
  await page.goto("/?path=/home/user&viewMode=details");
  const row = page.locator('.file-item[tabindex="0"]');
  await expect(row).toBeVisible();
  await focusBeforeFileList(page);
  await page.keyboard.press("Tab");
  await expect(row).toBeFocused();
  await expect.poll(() => row.evaluate((element) => {
    const left = element.getBoundingClientRect().left;
    const clippedBy: string[] = [];
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX === "visible") continue;
      const clipLeft = parent.getBoundingClientRect().left + (parseFloat(style.borderLeftWidth) || 0);
      if (left < clipLeft - 0.5) clippedBy.push(parent.className);
    }
    return clippedBy;
  })).toEqual([]);
  await expect(row.locator(".name-cell .icon")).toBeInViewport();
  await expect(row.locator(".name-text")).toBeInViewport();
});
