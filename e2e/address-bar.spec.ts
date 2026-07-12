/**
 * E2E: address bar path entry (#296).
 *
 * NOTE: There is no Ctrl+L shortcut in this codebase — the main nav bar's
 * address editing is entered by clicking the breadcrumbs container
 * (`.breadcrumbs-container` → `startPathEdit`), which swaps the crumbs for a
 * `.path-input`. These tests drive that real trigger and assert the pane
 * actually navigates (breadcrumb + listing change), that Escape cancels
 * without navigating, and the designed behaviour for a non-existent path.
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForEntries } from "./helpers";

/** Click the empty right area of the breadcrumbs bar to enter edit mode. */
async function openAddressBar(page: Page) {
  const bar = page.locator(".breadcrumbs-container");
  const box = await bar.boundingBox();
  // Click near the right edge so we hit padding, not a crumb button.
  await bar.click({ position: { x: (box?.width ?? 200) - 8, y: (box?.height ?? 30) / 2 } });
  const input = page.locator(".path-input");
  await expect(input).toBeVisible();
  return input;
}

test.describe("Address bar path entry", () => {
  test("typing a path and pressing Enter navigates the pane there", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);
    await expect(page.locator(".entry-item", { hasText: "readme.txt" })).toBeVisible();

    const input = await openAddressBar(page);
    await input.fill("/home/user/Documents");
    // Dismiss the autocomplete dropdown so Enter confirms navigation instead
    // of applying the highlighted suggestion.
    await page.locator(".suggestions-dropdown").waitFor({ state: "visible", timeout: 2000 });
    await input.press("Escape");
    await input.press("Enter");

    // The pane navigated: breadcrumb + listing both reflect Documents.
    await expect(page.locator(".breadcrumbs-container")).toContainText("Documents");
    await waitForEntries(page);
    await expect(page.locator(".entry-item", { hasText: "report.pdf" })).toBeVisible();
    await expect(page.locator(".entry-item", { hasText: "readme.txt" })).toHaveCount(0);
  });

  test("Escape cancels editing without navigating", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    const input = await openAddressBar(page);
    // A path with no matching sibling produces no suggestions, so a single
    // Escape cancels the edit outright.
    await input.fill("/home/user/Videos-typo");
    await input.press("Escape");

    // Editing ended and nothing navigated.
    await expect(page.locator(".path-input")).toHaveCount(0);
    await expect(page.locator(".breadcrumbs-container")).not.toContainText("Videos-typo");
    await expect(page.locator(".entry-item", { hasText: "readme.txt" })).toBeVisible();
  });

  test("a non-existent path surfaces an error state (designed behaviour)", async ({
    page,
  }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    const input = await openAddressBar(page);
    await input.fill("/home/user/does-not-exist-xyz");
    await input.press("Enter");

    // Designed behaviour: the backend rejects the unknown path, so the pane
    // shows the "Unable to access folder" error state rather than a listing.
    await expect(page.locator(".error-state .error-title")).toHaveText(
      "Unable to access folder",
      { timeout: 5000 },
    );
    await expect(page.locator(".error-state .error-message")).toContainText(
      "does-not-exist-xyz",
    );
    await expect(page.locator(".entry-item")).toHaveCount(0);
  });
});
