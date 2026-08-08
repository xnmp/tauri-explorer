import { test, expect } from "./fixtures";

test.describe("Quick Open recursive search debounce (#600)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.waitForSelector(".file-list");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
    await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
    await page.locator(".entry-item", { hasText: "project" }).first().waitFor({ timeout: 5000 });
    await page.locator(".entry-item", { hasText: "project" }).first().dblclick();
    await page.locator(".entry-item", { hasText: "src" }).first().waitFor({ timeout: 5000 });
  });

  test("shows local matches before starting one search for the completed query", async ({ page }) => {
    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    const searchInput = quickOpen.locator(".search-input");
    const localResult = quickOpen.locator(".result-name", { hasText: "src" }).first();
    await expect(searchInput).toBeVisible();

    // 80 ms is longer than the old 50 ms debounce but shorter than the fixed
    // 150 ms pause. Restoring the old behavior therefore records intermediate
    // `s`/`sr` requests and makes the direct no-request assertion below fail.
    await searchInput.pressSequentially("src", { delay: 80 });

    await expect(localResult).toBeVisible({ timeout: 40 });
    expect(await page.evaluate(() => localStorage.getItem("mock-streaming-searches"))).toBeNull();

    await expect
      .poll(
        () => page.evaluate(() => localStorage.getItem("mock-streaming-searches")),
        { timeout: 1000 },
      )
      .toBe(JSON.stringify([{ query: "src" }]));
    await expect(localResult).toBeVisible();
    await page.screenshot({ path: "evidence/ac-1-one-completed-query-search.png" });
  });

  test("shows active-pane, recent, and frecent matches during the search delay", async ({ page }) => {
    await page.evaluate(() => {
      const now = Date.now();
      localStorage.setItem("explorer-recent-files", JSON.stringify([
        {
          name: "report.pdf",
          path: "/home/user/Documents/report.pdf",
          kind: "file",
          timestamp: now,
        },
      ]));
      localStorage.setItem("explorer-frecency", JSON.stringify([
        { path: "/home/user/Documents", accesses: [now] },
      ]));
    });
    await page.reload();
    await page.locator(".entry-item", { hasText: "Documents" }).first().dblclick();
    await page.locator(".entry-item", { hasText: "project" }).first().waitFor({ timeout: 5000 });
    await page.locator(".entry-item", { hasText: "project" }).first().dblclick();
    await page.locator(".entry-item", { hasText: "Dockerfile" }).first().waitFor({ timeout: 5000 });

    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    const searchInput = quickOpen.locator(".search-input");
    await expect(searchInput).toBeVisible();
    await searchInput.pressSequentially("doc", { delay: 20 });

    await expect(quickOpen.locator(".result-name", { hasText: "Dockerfile" })).toBeVisible({ timeout: 40 });
    await expect(quickOpen.locator(".result-name", { hasText: "docs" })).toBeVisible({ timeout: 40 });
    await expect(quickOpen.locator(".result-name", { hasText: "report.pdf" })).toBeVisible({ timeout: 40 });
    await expect(quickOpen.locator(".result-name", { hasText: "Documents" })).toBeVisible({ timeout: 40 });
    expect(await page.evaluate(() => localStorage.getItem("mock-streaming-searches"))).toBeNull();
    await page.screenshot({ path: "evidence/ac-2-immediate-local-matches.png" });
  });

  test("shows recursive matches after the typing pause", async ({ page }) => {
    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    const searchInput = quickOpen.locator(".search-input");
    await expect(searchInput).toBeVisible();

    await searchInput.pressSequentially("components", { delay: 80 });

    await expect
      .poll(
        () => page.evaluate(() => localStorage.getItem("mock-streaming-searches")),
        { timeout: 1000 },
      )
      .toBe(JSON.stringify([{ query: "components" }]));
    await expect(quickOpen.locator(".result-name", { hasText: "components" }).first()).toBeVisible();
    await page.screenshot({ path: "evidence/ac-3-recursive-final-query-match.png" });
  });
});
