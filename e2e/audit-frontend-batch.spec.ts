/**
 * Audit batch (#1823): command-owned context-menu hints follow rebinding, and
 * a failed unstage is reported instead of swallowed.
 */
import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

declare global {
  interface Window {
    __mockControl?: MockControl;
  }
}

const SHOT_DIR = "screenshots/fix/audit-frontend-batch";

async function openFileMenu(page: Page) {
  await page.goto("/");
  await waitForEntries(page);
  await page.locator(".entry-item").first().click({ button: "right" });
  const menu = page.locator(".context-menu").first();
  await expect(menu).toBeVisible();
  return menu;
}

const hintOf = (menu: ReturnType<Page["locator"]>, label: string) =>
  menu.locator(".menu-item", { has: menu.page().locator("span", { hasText: new RegExp(`^${label}$`) }) });

test("context menu hints follow rebound and unbound commands", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("explorer-keybindings", JSON.stringify({
      "edit.copy": "Ctrl+Shift+Y",
      "edit.cut": null,
    }));
  });
  const menu = await openFileMenu(page);
  const copy = hintOf(menu, "Copy");
  await expect(copy.locator(".shortcut")).toHaveText("Ctrl+Shift+Y");
  await expect(hintOf(menu, "Cut").locator(".shortcut")).toHaveCount(0);
  // Untouched commands keep their default hint.
  await expect(hintOf(menu, "Rename").locator(".shortcut")).toHaveText("F2");
  await menu.screenshot({ path: `${SHOT_DIR}/context-menu-rebound-hint.png`, animations: "disabled" });
});

test("a failed unstage shows an error toast", async ({ page }) => {
  await page.goto("/");
  await applySettingsAndReload(page, { showGitStatus: true, showScmPanel: true });
  await page.waitForLoadState("domcontentloaded");
  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();
  await page.locator('[data-section="staged"]').waitFor({ state: "visible" });

  await page.evaluate(() => {
    const control = (window.__mockControl ??= {} as MockControl);
    control.failures = { ...(control.failures ?? {}), git_unstage: "index.lock exists" };
  });
  const row = page.locator('[data-section="staged"] .row').first();
  await row.hover();
  await row.getByRole("button", { name: /unstage/i }).click();

  await expect(page.locator(".toast.error")).toContainText("Unstage failed");
  await expect(page.locator(".toast.error")).toContainText("index.lock exists");
  // The row stays staged: nothing moved.
  await expect(page.locator('[data-section="staged"] .row')).toHaveCount(1);
  await page.screenshot({ path: `${SHOT_DIR}/scm-unstage-error.png`, animations: "disabled" });
});

test("SCM row hover highlights have no transition, and status colours resolve", async ({ page }) => {
  await page.goto("/");
  await applySettingsAndReload(page, { showGitStatus: true, showScmPanel: true });
  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();
  const row = page.locator('[data-section="changes"] .row').first();
  await expect(row).toBeVisible();
  expect(await row.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  const header = page.locator('[data-section="changes"] .section-header').first();
  expect(await header.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  const color = await row.locator(".s-modified").first().evaluate((el) => getComputedStyle(el).color);
  expect(color).toMatch(/^(rgb|color)\(/);
});
