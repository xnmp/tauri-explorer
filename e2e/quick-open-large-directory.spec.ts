import { expect, test } from "./fixtures";

test.describe("Quick Open in a directory with thousands of files (#651)", () => {
  test("keeps a broad active-directory query responsive and bounded", async ({ page }) => {
    await page.goto("/?path=/perf/huge");
    await page.locator(".entry-item").first().waitFor({ timeout: 10_000 });

    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    const input = quickOpen.locator(".search-input");
    await expect(input).toBeVisible();

    await input.fill("file");

    await expect(input).toHaveValue("file");
    await expect(quickOpen.locator(".result-name").first()).toContainText("file", {
      timeout: 1_000,
    });
    await expect(quickOpen.locator(".result-item")).toHaveCount(20);
  });
});
