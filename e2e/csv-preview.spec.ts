import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test.describe("CSV preview", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) await pressShortcut(page, " ", {});
    await expect(previewPane).toBeVisible();
  });

  test("renders CSV records as a virtualized table and keeps invalid CSV as text", async ({ page }) => {
    await page.locator(".entry-item", { hasText: "people.csv" }).first().click();

    const table = page.getByRole("table", { name: "CSV preview" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveText(["name", "note"]);
    await expect(table.getByRole("cell")).toHaveText([
      "Ada",
      "first, second",
      "Grace",
      'said "hello"\nand left',
    ]);
    await expect(page.locator(".preview-text")).toHaveCount(0);
    await page.screenshot({ path: "evidence/ac-1-csv-table.png" });

    await page.locator(".entry-item", { hasText: "broken.csv" }).first().click();
    await expect(page.locator(".preview-text")).toContainText('Ada,"unterminated');
    await page.screenshot({ path: "evidence/ac-2-malformed-csv-fallback.png" });

    await page.locator(".entry-item", { hasText: "readme.txt" }).first().click();
    await expect(page.locator(".preview-text")).toContainText("This is a readme file.");
    await page.screenshot({ path: "evidence/ac-3-text-preview-unchanged.png" });
  });
});
