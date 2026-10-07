import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test("syntax highlighting retains the configured preview font", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  if (!(await page.locator(".preview-pane").isVisible())) {
    await pressShortcut(page, " ", {});
  }
  await page.locator(".entry-item", { hasText: "index.ts" }).click();
  const preview = page.locator(".preview-code");
  await expect(preview).toContainText("export");
  await expect(preview.locator(".hljs-keyword").first()).toBeVisible();
  const fonts = await preview.evaluate(pre => {
    const code = pre.querySelector("code")!;
    return {
      configured: getComputedStyle(pre).fontFamily,
      highlighted: getComputedStyle(code).fontFamily,
      token: getComputedStyle(code.querySelector("span")!).fontFamily,
    };
  });
  expect(fonts.highlighted, JSON.stringify(fonts)).toBe(fonts.configured);
  expect(fonts.token).toBe(fonts.configured);
});
