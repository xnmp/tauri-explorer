/**
 * Per-pane tab strips (#140): each pane owns an independent tab strip.
 * Covers: strips render per pane in dual-pane mode, tabs open/switch
 * independently per pane, and closing the right pane's last tab collapses
 * back to single-pane.
 */

import { test, expect, type Page } from "@playwright/test";

async function openDualPane(page: Page): Promise<void> {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  await page.keyboard.press("Control+\\");
  await expect(page.locator(".pane-container.dual-pane")).toBeVisible();
  await expect(
    page.locator(".right-pane .entry-item").filter({ hasText: "user" }).first()
  ).toBeVisible();
}

test.describe("Per-pane tabs", () => {
  test("each pane shows its own tab strip in dual-pane mode", async ({ page }) => {
    await openDualPane(page);

    await expect(page.locator(".left-pane .tab-area")).toBeVisible();
    await expect(page.locator(".right-pane .tab-area")).toBeVisible();
    await expect(page.locator(".left-pane .tab")).toHaveCount(1);
    await expect(page.locator(".right-pane .tab")).toHaveCount(1);
  });

  test("a new tab in one pane leaves the other pane's strip untouched", async ({ page }) => {
    await openDualPane(page);

    // The right pane's + button adds a tab to the right strip only.
    await page.locator(".right-pane .new-tab-btn").click();
    await expect(page.locator(".right-pane .tab")).toHaveCount(2);
    await expect(page.locator(".left-pane .tab")).toHaveCount(1);

    // And the left pane's + button adds to the left strip only.
    await page.locator(".left-pane .new-tab-btn").click();
    await expect(page.locator(".left-pane .tab")).toHaveCount(2);
    await expect(page.locator(".right-pane .tab")).toHaveCount(2);
  });

  test("switching tabs in one pane keeps the other pane's directory", async ({ page }) => {
    await openDualPane(page);

    // Navigate left into Documents, then open a second left tab and navigate
    // it into Pictures — switching back must restore Documents, while the
    // right pane stays at /home throughout.
    await page
      .locator(".left-pane .entry-item")
      .filter({ hasText: "Documents" })
      .first()
      .dblclick();
    await expect(
      page.locator(".left-pane .entry-item").filter({ hasText: "report.pdf" })
    ).toBeVisible();

    await page.locator(".left-pane .new-tab-btn").click();
    await expect(page.locator(".left-pane .tab")).toHaveCount(2);
    // The new tab inherits Documents; go up to /home/user then into Pictures.
    await page.keyboard.press("Control+Alt+ArrowUp");
    await page
      .locator(".left-pane .entry-item")
      .filter({ hasText: "Pictures" })
      .first()
      .dblclick();
    await expect(
      page.locator(".left-pane .entry-item").filter({ hasText: "photo1.jpg" })
    ).toBeVisible();

    // Switch back to the first left tab → Documents contents again.
    await page.locator(".left-pane .tab").first().click();
    await expect(
      page.locator(".left-pane .entry-item").filter({ hasText: "report.pdf" })
    ).toBeVisible();

    // Right pane never moved.
    await expect(
      page.locator(".right-pane .entry-item").filter({ hasText: "user" }).first()
    ).toBeVisible();
  });

  test("closing the right pane's last tab collapses to single pane", async ({ page }) => {
    await openDualPane(page);

    const rightTab = page.locator(".right-pane .tab").first();
    await rightTab.hover();
    await rightTab.locator(".tab-close").click();

    await expect(page.locator(".pane-container.dual-pane")).toHaveCount(0);
    await expect(page.locator(".right-pane")).toHaveCount(0);
    await expect(page.locator(".left-pane .entry-item").first()).toBeVisible();
  });
});
