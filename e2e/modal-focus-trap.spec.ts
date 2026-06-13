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

  test("closing a dialog restores focus to the previously focused element", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    const row = page.locator(".entry-item").first();
    await row.click();
    await row.focus();
    await expect(row).toBeFocused();

    await page.keyboard.press("Delete");
    await expect(page.locator("[role='alertdialog'] .dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("[role='alertdialog']")).toHaveCount(0);
    await expect(row).toBeFocused();
  });

  test("palette dialogs (QuickOpen) keep focus inside on Tab", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    await page.keyboard.press("Control+p");
    const input = page.locator(".quick-open-dialog .search-input");
    await expect(input).toBeFocused();

    // The input is the only focusable element — Tab must cycle back to it,
    // never escaping to the page behind the overlay.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Tab");
      await expect(input).toBeFocused();
    }
  });

  test("Settings: Escape clears the filter first, second Escape closes", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    await page.keyboard.press("Control+,");
    const dialog = page.locator(".settings-dialog");
    await expect(dialog).toBeVisible();

    const search = page.locator(".settings-search");
    await search.fill("theme");

    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("Workspaces: Escape steps back from save form before closing", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    // Open via the command palette (no direct shortcut).
    await page.keyboard.press("Control+Shift+P");
    await page.locator(".command-palette-dialog .search-input").fill("workspaces manage");
    await page.keyboard.press("Enter");

    const dialog = page.locator(".dialog-backdrop .dialog");
    await expect(dialog).toBeVisible();

    await page.getByRole("button", { name: "Save Current Layout" }).click();
    await expect(page.locator(".save-input")).toBeVisible();

    // First Escape leaves save mode, dialog stays open.
    await page.keyboard.press("Escape");
    await expect(page.locator(".save-input")).toHaveCount(0);
    await expect(dialog).toBeVisible();

    // Second Escape closes.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("toasts render above open modals (z-index scale)", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    // Trigger a clipboard toast, then open a modal on top of it.
    await page.locator(".entry-item").first().click();
    await page.keyboard.press("Control+c");
    await expect(page.locator(".toast")).toBeVisible();

    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog")).toBeVisible();

    const { toastZ, modalZ } = await page.evaluate(() => {
      const toast = document.querySelector(".toast-container") as HTMLElement;
      const overlay = document.querySelector(".modal-overlay") as HTMLElement;
      return {
        toastZ: Number(getComputedStyle(toast).zIndex),
        modalZ: Number(getComputedStyle(overlay).zIndex),
      };
    });
    expect(Number.isFinite(toastZ)).toBe(true);
    expect(Number.isFinite(modalZ)).toBe(true);
    expect(toastZ).toBeGreaterThan(modalZ);
  });
});
