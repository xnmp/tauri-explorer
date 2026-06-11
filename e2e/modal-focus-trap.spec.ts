/**
 * Modal primitive behavior (Modal.svelte): focus containment, Escape,
 * backdrop click. Exercised through the delete confirmation dialog —
 * all dialogs share the same primitive.
 */

import { test, expect, type Page } from "@playwright/test";

async function openDeleteDialog(page: Page): Promise<void> {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  await page.locator(".entry-item").first().click();
  await page.keyboard.press("Delete");
  await expect(page.locator("[role='alertdialog'] .dialog")).toBeVisible({ timeout: 2000 });
}

test.describe("Modal primitive", () => {
  test("Tab cycles focus inside the dialog without escaping it", async ({ page }) => {
    await openDeleteDialog(page);

    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const overlay = document.querySelector("[role='alertdialog']");
        return overlay ? overlay.contains(document.activeElement) : false;
      });
      expect(inside, `focus left the dialog after ${i + 1} Tabs`).toBe(true);
    }

    // Two focusables (Cancel, Delete): an odd number of Tabs from the
    // overlay lands on Cancel again after wrapping.
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  });

  test("Shift+Tab wraps backwards to the last control", async ({ page }) => {
    await openDeleteDialog(page);

    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: /Delete/ })).toBeFocused();
  });

  test("Escape closes the dialog without deleting", async ({ page }) => {
    await openDeleteDialog(page);
    const countBefore = await page.locator(".entry-item").count();

    await page.keyboard.press("Escape");

    await expect(page.locator("[role='alertdialog']")).toHaveCount(0);
    await expect(page.locator(".entry-item")).toHaveCount(countBefore);
  });

  test("backdrop click closes the dialog, inner click does not", async ({ page }) => {
    await openDeleteDialog(page);

    await page.locator("[role='alertdialog'] .dialog h2").click();
    await expect(page.locator("[role='alertdialog'] .dialog")).toBeVisible();

    await page.locator("[role='alertdialog']").click({ position: { x: 5, y: 5 } });
    await expect(page.locator("[role='alertdialog']")).toHaveCount(0);
  });
});
