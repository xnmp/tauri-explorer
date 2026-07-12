/**
 * Dual-pane layout: toggle, independent navigation, and cross-pane refresh.
 *
 * Cross-pane refresh is the regression guard for the active-pane
 * unification refactor: file mutations broadcast a change which refreshes
 * the visible panes via windowTabsManager.refreshAllPanes(), so a directory
 * shown in the inactive pane must pick up files created in the active one.
 */

import { test, expect, type Page } from "@playwright/test";

const leftPane = (page: Page) => page.locator(".explorer-pane").first();
const rightPane = (page: Page) => page.locator(".explorer-pane").nth(1);

async function openDualPane(page: Page): Promise<void> {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".pane-split")).toBeVisible();
  // When both panes would show the same path, the second pane opens at the
  // parent directory (/home) by design.
  await expect(
    rightPane(page).locator(".entry-item").filter({ hasText: "user" }).first()
  ).toBeVisible();
}

test.describe("Dual pane", () => {
  test("Ctrl+\\ toggles the second pane on and off @smoke", async ({ page }) => {
    await openDualPane(page);

    await page.keyboard.press("Control+\\");
    await expect(page.locator(".pane-split")).toHaveCount(0);
    await expect(page.locator(".explorer-pane")).toHaveCount(1);
  });

  test("panes navigate independently", async ({ page }) => {
    await openDualPane(page);

    // Navigate the left pane into Documents; the right pane (at /home) must stay put.
    await leftPane(page)
      .locator(".entry-item")
      .filter({ hasText: "Documents" })
      .first()
      .dblclick();

    await expect(
      leftPane(page).locator(".entry-item").filter({ hasText: "report.pdf" })
    ).toBeVisible();
    await expect(
      rightPane(page).locator(".entry-item").filter({ hasText: "user" }).first()
    ).toBeVisible();
    await expect(
      rightPane(page).locator(".entry-item").filter({ hasText: "report.pdf" })
    ).toHaveCount(0);
  });

  // Automatic cross-pane propagation is driven by the backend filesystem
  // watcher, which doesn't exist in browser mode (the refreshAllPanes wiring
  // is unit-tested in tests/state/window-tabs.test.ts). This covers the rest
  // of the chain: both panes share one filesystem, and a refresh in the
  // other pane picks up a change made from the first.
  test("a folder created in one pane is visible in the other after refresh", async ({ page }) => {
    await openDualPane(page);

    // Bring the right pane to /home/user so both panes show the same dir.
    await rightPane(page)
      .locator(".entry-item")
      .filter({ hasText: "user" })
      .first()
      .dblclick();
    await expect(
      rightPane(page).locator(".entry-item").filter({ hasText: "Documents" })
    ).toBeVisible();

    // Create a folder in the left pane (context menu → inline input).
    await leftPane(page).locator(".file-list .content").first().click({
      button: "right",
      position: { x: 10, y: 400 },
    });
    await page.locator(".context-menu").getByText("New folder", { exact: false }).click();

    const input = leftPane(page).locator(".new-folder-input");
    await expect(input).toBeVisible();
    await input.fill("cross-pane-test");
    await input.press("Enter");

    await expect(
      leftPane(page).locator(".entry-item").filter({ hasText: "cross-pane-test" })
    ).toBeVisible();

    // Refresh the right pane (click to activate, F5) — the new folder must
    // appear there too.
    await rightPane(page).locator(".file-list .content").first().click({ position: { x: 10, y: 400 } });
    await page.keyboard.press("F5");
    await expect(
      rightPane(page).locator(".entry-item").filter({ hasText: "cross-pane-test" })
    ).toBeVisible();
  });
});
