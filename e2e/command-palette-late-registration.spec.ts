/**
 * E2E: the open command palette tracks commands that plugins register or
 * remove after it opened (#1270). Plugins activate asynchronously at startup,
 * so a palette opened early used to show "No matching commands" until reopened.
 */
import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, waitForEntries } from "./helpers";

const LABEL = "Demo: Toggle Cards View";

async function setDemoEnabled(page: Page, enabled: boolean) {
  await page.evaluate(async (value) => {
    const load = new Function("path", "return import(path)");
    const { pluginRegistry } = await load("/src/lib/plugins/registry.svelte.ts");
    await pluginRegistry.setEnabled("demo", value);
  }, enabled);
}

test("a plugin command appears in, then leaves, an already-open palette", async ({ page }) => {
  await page.goto("/?path=/home/user");
  await applySettingsAndReload(page, { pluginsEnabled: { demo: false } });
  await waitForEntries(page);

  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator(".search-input").fill(LABEL);
  const item = palette.locator(".command-item").filter({ has: page.locator(".command-label", { hasText: LABEL }) });
  await expect(item).toHaveCount(0);

  await setDemoEnabled(page, true);
  await expect(item).toHaveCount(1);

  await setDemoEnabled(page, false);
  await expect(item).toHaveCount(0);
  await expect(palette).toBeVisible();
});
