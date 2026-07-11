/**
 * Column / palette sorting in Details view.
 * Issue: test/e2e-coverage-tier1
 *
 * Fixtures — /home/user/Documents (see mock-invoke.ts):
 *   project/ (dir), report.pdf (100 KB), budget.xlsx (50 KB),
 *   presentation.pptx (200 KB), notes.md (4 KB).
 * Mock timestamps increase in creation order, so date-modified ascending
 * follows the listing order of the files.
 *
 * Directories always sort first regardless of field or direction.
 * The Type column header is not clickable (by design) — type sorting is
 * only reachable via the palette command.
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForEntries } from "./helpers";

const DOCS_URL = "/?path=/home/user/Documents";

// Expected orders derived from the fixtures above.
const NAME_ASC = ["project", "budget.xlsx", "notes.md", "presentation.pptx", "report.pdf"];
const SIZE_ASC = ["project", "notes.md", "budget.xlsx", "report.pdf", "presentation.pptx"];
const SIZE_DESC = ["project", "presentation.pptx", "report.pdf", "budget.xlsx", "notes.md"];
const TYPE_ASC = ["project", "notes.md", "report.pdf", "presentation.pptx", "budget.xlsx"];
const DATE_ASC = ["project", "report.pdf", "budget.xlsx", "presentation.pptx", "notes.md"];

async function names(page: Page): Promise<string[]> {
  return page.locator(".entry-item .entry-name").allTextContents();
}

async function expectOrder(page: Page, expected: string[]): Promise<void> {
  await expect.poll(() => names(page)).toEqual(expected);
}

async function runPaletteCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.waitFor({ state: "visible", timeout: 2000 });
  await palette.locator(".search-input").fill(label);
  const cmd = palette.locator(`.command-item:has-text("${label}")`).first();
  await expect(cmd).toBeVisible();
  await cmd.click();
  await expect(palette).toBeHidden();
}

test.describe("Sorting", () => {
  test("defaults to name ascending", async ({ page }) => {
    await page.goto(DOCS_URL);
    await waitForEntries(page);
    await expectOrder(page, NAME_ASC);
  });

  test("Size header sorts ascending, then descending on a second click", async ({ page }) => {
    await page.goto(DOCS_URL);
    await waitForEntries(page);

    await page.locator(".column-header.size-column").click();
    await expectOrder(page, SIZE_ASC);

    await page.locator(".column-header.size-column").click();
    await expectOrder(page, SIZE_DESC);
  });

  test("Date modified header orders by modified time", async ({ page }) => {
    await page.goto(DOCS_URL);
    await waitForEntries(page);

    await page.locator(".column-header.date-column").click();
    await expectOrder(page, DATE_ASC);
  });

  test("palette Sort by Size matches the header sort", async ({ page }) => {
    await page.goto(DOCS_URL);
    await waitForEntries(page);

    await runPaletteCommand(page, "Sort by Size");
    await expectOrder(page, SIZE_ASC);
  });

  test("palette Sort by Type orders by extension", async ({ page }) => {
    await page.goto(DOCS_URL);
    await waitForEntries(page);

    await runPaletteCommand(page, "Sort by Type");
    await expectOrder(page, TYPE_ASC);
  });

  test("sort preference persists across navigation", async ({ page }) => {
    await page.goto(DOCS_URL);
    await waitForEntries(page);

    await page.locator(".column-header.size-column").click();
    await expectOrder(page, SIZE_ASC);

    // Leave to the parent and come back — the per-directory sort is restored.
    // (The home crumb collapses to an icon, so navigate up via the toolbar.)
    await page.getByRole("button", { name: "Go up one level" }).click();
    await waitForEntries(page);
    await page.locator(".entry-item.directory", { hasText: "Documents" }).first().dblclick();
    await waitForEntries(page);

    await expectOrder(page, SIZE_ASC);
  });
});
