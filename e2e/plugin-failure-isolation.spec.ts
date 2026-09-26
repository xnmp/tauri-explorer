/**
 * Plugin failure isolation (#782): a plugin action whose backend fails
 * reports its own error, and leaves every other plugin usable.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

async function contextMenuOn(page: Page, name: string) {
  const entry = page.locator(".entry-item").filter({ hasText: name }).first();
  await expect(entry).toBeVisible();
  await entry.click();
  await entry.click({ button: "right" });
  const menu = page.locator(".context-menu");
  await menu.waitFor({ state: "visible" });
  return menu;
}

async function aiMenuItem(menu: ReturnType<Page["locator"]>, label: string) {
  const aiGroup = menu.locator(":scope > .submenu-wrapper").filter({ hasText: "AI" });
  await aiGroup.hover();
  return aiGroup.locator(`.submenu .menu-item:has-text("${label}")`);
}

const setFailure = (page: Page, command: string, message: string | null) =>
  page.evaluate(([name, error]) => {
    const g = globalThis as { __MOCK_FAILURES__?: Record<string, string> };
    g.__MOCK_FAILURES__ = error === null ? {} : { [name]: error };
  }, [command, message] as const);

test("a failing plugin action reports its error while another plugin still works", async ({ page }) => {
  await page.goto("/?path=/home/user/Downloads");
  await waitForEntries(page);
  const themeBefore = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));

  // The plugin lets the backend's rejection escape; the plugin context reports
  // it under the plugin's name.
  await setFailure(page, "extract_palette", "palette service unavailable");
  let menu = await contextMenuOn(page, "image.png");
  await menu.locator(".menu-item", { hasText: "Create Theme from Image" }).click();
  // Error toasts dismiss after 3 s, so assert and capture it before anything slower.
  const failure = page.locator(".toast.error");
  await expect(failure).toHaveText("Theme from Image: palette service unavailable");
  // Finish the toast's entrance animation so the capture shows it.
  await page.screenshot({ path: "screenshots/test/plugin-failure-isolation/failure-beside-working-plugin.png", animations: "disabled" });
  expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(themeBefore);

  // Another plugin's action on the same file is unaffected.
  menu = await contextMenuOn(page, "image.png");
  await (await aiMenuItem(menu, "Upscale Image")).click();
  const dialog = page.locator('[aria-labelledby="upscale-title"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".file-name")).toContainText("image.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The failure was confined to that one call: the same action succeeds once
  // its backend recovers.
  await setFailure(page, "extract_palette", null);
  menu = await contextMenuOn(page, "image.png");
  await menu.locator(".menu-item", { hasText: "Create Theme from Image" }).click();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
    .toMatch(/^img-/);
});
