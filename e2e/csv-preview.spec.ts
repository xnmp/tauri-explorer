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
    await page.locator('[data-path="/home/user/people.csv"]').click();

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

    await page.locator('[data-path="/home/user/broken.csv"]').click();
    await expect(page.locator(".preview-text")).toContainText('Ada,"unterminated');
    await page.screenshot({ path: "evidence/ac-2-malformed-csv-fallback.png" });

    await page.locator('[data-path="/home/user/readme.txt"]').click();
    await expect(page.locator(".preview-text")).toContainText("This is a readme file.");
    await page.screenshot({ path: "evidence/ac-3-text-preview-unchanged.png" });

    await page.locator('[data-path="/home/user/notes.md"]').click();
    const markdown = page.locator(".preview-markdown");
    await expect(markdown).toBeVisible();
    await expect(markdown.locator("h1")).toHaveText("Notes");
    await page.screenshot({ path: "evidence/ac-4-markdown-preview-unchanged.png" });
  });

  test("bounds large CSV previews and virtualizes rows while scrolling", async ({ page }) => {
    await page.locator('[data-path="/home/user/many-people.csv"]').click();

    const rows = page.locator(".preview-csv-rows [role=row]");
    await expect(rows.first()).toContainText("Person 1");
    expect(await rows.count()).toBeLessThan(50);

    await page.locator(".preview-csv-rows").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(rows.last()).toContainText("Person 200");
    expect(await rows.count()).toBeLessThan(50);
    await page.screenshot({ path: "evidence/ac-5-large-csv-virtualized.png" });
  });

  test("keeps wide CSV columns aligned and horizontally reachable", async ({ page }) => {
    await page.locator('[data-path="/home/user/wide.csv"]').click();

    const table = page.getByRole("table", { name: "CSV preview" });
    const headers = table.getByRole("columnheader");
    const cells = table.getByRole("cell");
    await expect(headers).toHaveText(["first", "description", "final"]);
    await expect(cells.last()).toHaveText("reachable final value");

    const alignment = await page.locator(".preview-csv").evaluate((scroller) => {
      const header = scroller.querySelectorAll<HTMLElement>('[role="columnheader"]')[2];
      const cell = scroller.querySelectorAll<HTMLElement>('[role="cell"]')[2];
      return {
        difference: Math.abs(header.getBoundingClientRect().left - cell.getBoundingClientRect().left),
        header: getComputedStyle(header.parentElement!).gridTemplateColumns,
        cell: getComputedStyle(cell.parentElement!).gridTemplateColumns,
      };
    });
    expect(alignment).toEqual({ difference: 0, header: alignment.header, cell: alignment.header });

    await page.locator(".preview-csv").evaluate((scroller) => {
      scroller.scrollLeft = scroller.scrollWidth;
    });
    await expect(headers.last()).toBeInViewport();
    await expect(cells.last()).toBeInViewport();
    await page.screenshot({ path: "evidence/ac-6-wide-csv-columns.png" });
  });
});
