/**
 * Details "Date opened" column (#1525): an app-owned open history recorded on
 * successful launches. Hidden by default; sortable with never-opened files last.
 */
import { test, expect, type Page } from "./fixtures";
import { seedSettings } from "./helpers";

const SHOTS = "screenshots/feat/date-opened";
const DOCS = "/home/user/Documents";
const row = (page: Page, name: string) => page.locator(`.details-view .entry-item[data-path="${DOCS}/${name}"]`);

async function openDocuments(page: Page, opened: boolean) {
  await seedSettings(page, { zoomLevel: 100, columnVisibility: { prompt: true, date: true, type: true, size: true, length: false, resolution: false, opened } }, { replace: true });
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto(`/?path=${DOCS}&viewMode=details`);
  await expect(row(page, "report.pdf")).toBeVisible();
}

test("Date opened is hidden by default and offered in the column menu", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto(`/?path=${DOCS}&viewMode=details`);
  await expect(row(page, "report.pdf")).toBeVisible();
  await expect(page.locator(".column-header.opened-column")).toHaveCount(0);
  await expect(page.locator(".details-view .opened-cell")).toHaveCount(0);
  await page.locator(".details-view .column-headers").click({ button: "right" });
  const item = page.locator(".column-menu-item", { hasText: "Date opened" });
  await expect(item).not.toContainText("✓");
  await page.screenshot({ path: `${SHOTS}/column-menu-date-opened.png`, animations: "disabled" });
  await item.click();
  await expect(page.locator(".column-header.opened-column")).toHaveText(/Date opened/i);
  await expect(row(page, "report.pdf").locator(".opened-cell")).toHaveText("");
});

test("opening files fills their Date opened cells and sorting puts them first", async ({ page }) => {
  await openDocuments(page, true);
  const reportCell = row(page, "report.pdf").locator(".opened-cell");
  await expect(reportCell).toHaveText("");

  // Opening a file (double-click) launches it through api/open.ts.
  await row(page, "budget.xlsx").dblclick();
  await expect(row(page, "budget.xlsx").locator(".opened-cell")).not.toHaveText("");
  await expect(row(page, "budget.xlsx").locator(".opened-cell")).toHaveAttribute("title", /\d/);
  await row(page, "presentation.pptx").dblclick();
  await expect(row(page, "presentation.pptx").locator(".opened-cell")).not.toHaveText("");
  // Never-opened files and folders stay blank.
  await expect(reportCell).toHaveText("");
  await expect(row(page, "notes.md").locator(".opened-cell")).toHaveText("");
  await expect(row(page, "project").locator(".opened-cell")).toHaveText("");

  await page.locator(".column-header.opened-column").click();
  await expect(page.locator(".column-header.opened-column")).toHaveClass(/active/);
  const files = page.locator('.details-view .entry-item:not(.directory)');
  await expect(files.first()).toHaveAttribute("data-path", `${DOCS}/budget.xlsx`);
  await expect(files.nth(1)).toHaveAttribute("data-path", `${DOCS}/presentation.pptx`);
  // Descending: most recent first, never-opened files still last.
  await page.locator(".column-header.opened-column").click();
  await expect(files.first()).toHaveAttribute("data-path", `${DOCS}/presentation.pptx`);
  await expect(files.nth(1)).toHaveAttribute("data-path", `${DOCS}/budget.xlsx`);
  await page.locator(".details-view").screenshot({ path: `${SHOTS}/details-date-opened-column.png`, animations: "disabled" });

  // The coalesced save reaches the (mock) app-data store, so a reload keeps it.
  await expect.poll(() => page.evaluate(() => localStorage.getItem("mock-open-history") ?? "")).toContain(`${DOCS}/budget.xlsx`);
  await page.reload();
  await expect(row(page, "budget.xlsx").locator(".opened-cell")).not.toHaveText("");
});
