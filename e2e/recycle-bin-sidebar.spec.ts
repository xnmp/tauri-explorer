import { test, expect } from "./fixtures";

test.describe("Recycle Bin sidebar entry (#603)", () => {
  test("shows the Recycle Bin below Bookmarks by default", async ({ page }) => {
    await page.goto("/");

    const bookmarks = page.getByRole("region", { name: /Bookmarks/i });
    const recycleBin = page.getByRole("button", { name: "Open Recycle Bin" });

    await expect(recycleBin).toBeVisible();
    expect(await bookmarks.evaluate((section) => {
      const button = section.querySelector(".recycle-bin-item");
      return button !== null && button.previousElementSibling !== null;
    })).toBe(true);
    await recycleBin.click();
    await page.screenshot({ path: "evidence/ac-1-recycle-bin-visible.png" });
  });

  test("hides the Recycle Bin after its persisted sidebar option is disabled", async ({ page }) => {
    await page.goto("/");
    await page.locator(".entry-item").first().waitFor();
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", {
      key: ",", ctrlKey: true, bubbles: true, cancelable: true,
    })));
    await expect(page.locator(".settings-search")).toBeVisible();
    await page.locator("label.toggle", { has: page.getByTestId("setting-show-recycle-bin") }).click();
    await expect(page.getByRole("button", { name: "Open Recycle Bin" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() =>
      JSON.parse(localStorage.getItem("explorer-settings") ?? "{}").showRecycleBin,
    )).toBe(false);
    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-dialog")).toHaveCount(0);
    await page.reload();

    await expect(page.getByRole("button", { name: "Open Recycle Bin" })).toHaveCount(0);
    await page.locator(".sidebar").screenshot({ path: "evidence/ac-2-recycle-bin-hidden.png" });
  });
});
