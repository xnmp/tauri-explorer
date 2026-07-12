/**
 * E2E: second-tier context-menu actions (#296).
 *
 * Covers the archive actions and the copy→paste path round-trip.
 *
 * Note on "copy path": there is no context-menu action (or command) that
 * writes a file's path string to the text clipboard in this codebase — the
 * only "copy" is the file clipboard (Cut/Copy → paste). So instead of a
 * non-existent feature, the copy test asserts the real outcome: Copy captures
 * the entry's full path so a subsequent Paste in another directory recreates
 * it there. open-with / set-as-wallpaper are native-only and skipped.
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForEntries, pressShortcut } from "./helpers";

async function rightClick(page: Page, name: string) {
  const item = page.locator(".entry-item", { hasText: name }).first();
  await item.click();
  await expect(item).toHaveClass(/selected/);
  await item.click({ button: "right" });
  const menu = page.locator(".context-menu");
  await menu.waitFor({ state: "visible", timeout: 2000 });
  return menu;
}

test.describe("Context-menu archive actions", () => {
  test("Compress to ZIP adds a .zip archive to the listing", async ({ page }) => {
    await page.goto("/?path=/home/user/Pictures");
    await waitForEntries(page);

    const zipNames = page.locator(".entry-item .entry-name", { hasText: ".zip" });
    await expect(zipNames).toHaveCount(0);

    const menu = await rightClick(page, "photo1.jpg");
    await menu.getByText("Compress to ZIP").click();

    // The new archive appears without a manual refresh.
    await expect(zipNames).toHaveCount(1, { timeout: 5000 });
    await expect(zipNames).toContainText("photo1.jpg.zip");
  });

  test("Extract Here unpacks the archive's contents into the current folder", async ({
    page,
  }) => {
    await page.goto("/?path=/home/user/Downloads");
    await waitForEntries(page);

    // Preconditions: archive.zip exists, its extracted contents do not yet.
    await expect(
      page.locator(".entry-item .entry-name", { hasText: "data.json" }),
    ).toHaveCount(0);

    const menu = await rightClick(page, "archive.zip");
    await menu.getByText("Extract Here", { exact: true }).click();

    // Extracted entries show up in the same directory.
    await expect
      .poll(() => page.locator(".entry-item .entry-name").allTextContents(), {
        timeout: 5000,
      })
      .toEqual(expect.arrayContaining(["data.json", "README.md"]));
  });
});

test.describe("Copy → Paste round-trips the full path", () => {
  test("Copy captures a file so Paste recreates it in another directory", async ({
    page,
  }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);

    // Copy report.pdf via the context menu.
    const menu = await rightClick(page, "report.pdf");
    await menu.getByText("Copy", { exact: true }).click();
    await expect(page.locator(".toast.clipboard")).toBeVisible();

    // Navigate to a different directory (sibling) without a reload.
    await page.keyboard.press("Control+Alt+ArrowUp");
    await expect(page.locator(".breadcrumbs-container")).not.toContainText("Documents");
    await waitForEntries(page);
    await page.locator(".entry-item", { hasText: "Pictures" }).first().dblclick();
    await expect(page.locator(".breadcrumbs-container")).toContainText("Pictures");
    await waitForEntries(page);

    // report.pdf is not in Pictures yet.
    await expect(
      page.locator(".entry-item .entry-name", { hasText: "report.pdf" }),
    ).toHaveCount(0);

    // Paste — the copied file (identified by its full source path) lands here.
    await pressShortcut(page, "v", { ctrlKey: true });
    await expect
      .poll(() => page.locator(".entry-item .entry-name").allTextContents(), {
        timeout: 5000,
      })
      .toContain("report.pdf");
  });
});
