/**
 * Content search dialog (Ctrl+Shift+F).
 *
 * Runs against the mock backend, which searches the virtual filesystem and
 * returns the complete result set inline (browser mode has no Tauri event
 * stream). Asserts on actual search outcomes: matched files, highlighted
 * line content, filtering, case sensitivity, and keyboard navigation.
 */

import { test, expect, type Page } from "@playwright/test";

async function openContentSearch(page: Page): Promise<void> {
  await page.goto("/?path=/home/user");
  await page.waitForSelector(".file-list");
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  await page.keyboard.press("Control+Shift+F");
  await expect(page.locator(".content-search-dialog")).toBeVisible({ timeout: 2000 });
}

test.describe("Content search (Ctrl+Shift+F)", () => {
  test("searching finds matches across files with highlighted content", async ({ page }) => {
    await openContentSearch(page);

    const input = page.locator(".content-search-dialog .search-input");
    await expect(input).toBeFocused();
    await input.fill("greet");

    // Mock fs has "greet" in Documents/project/index.ts and main.py.
    const items = page.locator(".result-item");
    await expect(items.filter({ hasText: "Documents/project/index.ts" })).toBeVisible();
    await expect(items.filter({ hasText: "Documents/project/main.py" })).toBeVisible();

    // Matched substring is wrapped in <mark> within the line content.
    await expect(page.locator(".line-content mark").first()).toHaveText("greet");

    // Footer reports real totals.
    await expect(page.locator(".footer .stats")).toHaveText(/2 matches in 2 files/);
  });

  test("filter input narrows results to matching files", async ({ page }) => {
    await openContentSearch(page);

    await page.locator(".content-search-dialog .search-input").fill("greet");
    await expect(page.locator(".result-item").filter({ hasText: "main.py" })).toBeVisible();

    await page.locator(".filter-input").fill("py");

    await expect(page.locator(".result-item").filter({ hasText: "main.py" })).toBeVisible();
    await expect(page.locator(".result-item").filter({ hasText: "index.ts" })).toHaveCount(0);
  });

  test("case-sensitive toggle changes match results", async ({ page }) => {
    await openContentSearch(page);

    const input = page.locator(".content-search-dialog .search-input");
    await input.fill("hello");

    // Case-insensitive by default: "Hello" in file contents matches.
    await expect(page.locator(".result-item").first()).toBeVisible();

    // Enable match-case: lowercase "hello" no longer matches anything.
    await page.locator('.option-btn[title*="Match Case"]').click();
    await expect(page.locator(".no-results")).toHaveText("No matches found");
  });

  test("arrow keys move selection between results", async ({ page }) => {
    await openContentSearch(page);

    await page.locator(".content-search-dialog .search-input").fill("greet");
    await expect(page.locator(".result-item").first()).toBeVisible();

    await expect(page.locator('.result-item[aria-selected="true"]')).toHaveCount(1);
    const firstSelected = await page
      .locator('.result-item[aria-selected="true"]')
      .textContent();

    await page.keyboard.press("ArrowDown");

    await expect(page.locator('.result-item[aria-selected="true"]')).toHaveCount(1);
    const secondSelected = await page
      .locator('.result-item[aria-selected="true"]')
      .textContent();
    expect(secondSelected).not.toBe(firstSelected);
  });

  test("Enter on a result opens it and closes the dialog", async ({ page }) => {
    await openContentSearch(page);

    await page.locator(".content-search-dialog .search-input").fill("greet");
    await expect(page.locator(".result-item").first()).toBeVisible();

    await page.keyboard.press("Enter");

    await expect(page.locator(".content-search-dialog")).toHaveCount(0);
  });

  test("regex mode matches patterns", async ({ page }) => {
    await openContentSearch(page);

    // Enable regex before typing.
    await page.locator('.option-btn[title*="Use Regex"]').click();

    const input = page.locator(".content-search-dialog .search-input");
    await input.fill("def \\w+");

    const pyResult = page.locator(".result-item").filter({ hasText: "main.py" });
    await expect(pyResult).toBeVisible();
    await expect(page.locator(".line-content mark").first()).toHaveText("def greet");
  });

  test("escape closes the dialog", async ({ page }) => {
    await openContentSearch(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".content-search-dialog")).toHaveCount(0);
  });

  test("files with many matches collapse behind a 'more matches' row that expands", async ({ page }) => {
    // index.ts has 7 case-insensitive "n" matches — over the collapse limit
    // of 5; main.py and package.json stay under it.
    await page.goto("/?path=/home/user/Documents/project");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
    await page.keyboard.press("Control+Shift+F");
    await expect(page.locator(".content-search-dialog")).toBeVisible();

    await page.locator(".content-search-dialog .search-input").fill("n");

    const showMore = page.locator(".show-more-row");
    await expect(showMore).toHaveText(/2 more matches/);
    const collapsedCount = await page.locator(".result-item").count();

    await showMore.click();

    // Expanding reveals the hidden rows and removes the show-more row.
    await expect(page.locator(".show-more-row")).toHaveCount(0);
    await expect
      .poll(() => page.locator(".result-item").count())
      .toBeGreaterThan(collapsedCount);
  });

  test("Enter re-runs the search when the query changed instead of opening a result", async ({ page }) => {
    await openContentSearch(page);

    const input = page.locator(".content-search-dialog .search-input");
    await input.fill("greet");
    await expect(page.locator(".result-item").first()).toBeVisible();

    // Change the query and hit Enter before the debounce fires: this must
    // start a new search (finding nothing), not open the stale selection.
    await input.pressSequentially("zz");
    await page.keyboard.press("Enter");

    await expect(page.locator(".no-results")).toHaveText("No matches found");
    await expect(page.locator(".content-search-dialog")).toBeVisible();
  });
});
