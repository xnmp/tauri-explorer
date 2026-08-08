import { test, expect } from "./fixtures";

test.describe("Recycle Bin sidebar entry (#603)", () => {
  test("shows the Recycle Bin below Bookmarks by default", async ({ page }) => {
    await page.goto("/");

    const bookmarks = page.getByRole("region", { name: /Bookmarks/i });
    const recycleBin = page.getByRole("button", { name: "Open Recycle Bin" });

    await expect(recycleBin).toBeVisible();
    expect(await bookmarks.evaluate((section, button) =>
      Boolean(section.compareDocumentPosition(button as Node) & Node.DOCUMENT_POSITION_FOLLOWING),
      await recycleBin.elementHandle(),
    )).toBe(true);
  });

  test("hides the Recycle Bin after its persisted sidebar option is disabled", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const settings = raw ? JSON.parse(raw) : {};
      settings.showRecycleBin = false;
      localStorage.setItem("explorer-settings", JSON.stringify(settings));
    });
    await page.reload();

    await expect(page.getByRole("button", { name: "Open Recycle Bin" })).toHaveCount(0);
  });
});
