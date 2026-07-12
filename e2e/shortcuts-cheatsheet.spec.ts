/**
 * Shortcut cheatsheet + first-run hint (#186): discoverability of the
 * keyboard-first workflow.
 */

import { test, expect } from "@playwright/test";
import { waitForEntries } from "./helpers";

test.describe("shortcut cheatsheet", () => {
  test("Ctrl+/ opens the cheatsheet with real bindings", async ({ page }) => {
    await page.goto("/");
    await waitForEntries(page);
    await page.keyboard.press("Control+/");

    const sheet = page.locator('[data-testid="shortcut-cheatsheet"]');
    await expect(sheet).toBeVisible();
    // Real command labels with their shortcuts, grouped by category.
    await expect(sheet).toContainText("Command Palette");
    await expect(sheet.locator("kbd", { hasText: "Ctrl+Shift+P" }).first()).toBeVisible();
    await expect(sheet.locator("h3", { hasText: "Navigation" })).toBeVisible();
    // Hardcoded (non-registry) bindings are listed too.
    await expect(sheet).toContainText("Toggle Dual Pane");

    await page.keyboard.press("Escape");
    await expect(sheet).not.toBeVisible();
  });

  test("cheatsheet opens from the command palette @smoke", async ({ page }) => {
    await page.goto("/");
    await waitForEntries(page);
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Keyboard Shortcuts");
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="shortcut-cheatsheet"]')).toBeVisible();
  });
});

test.describe("first-run hint", () => {
  test("removed: never appears, even on a fresh profile (#220)", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-testid="first-run-hint"]')).toHaveCount(0);
  });
});
