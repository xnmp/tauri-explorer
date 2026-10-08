import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test("Settings opens a separate Plugins menu and changes persist there", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.keyboard.press("Control+,");
  const general = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(general).toBeVisible();
  await expect(general.getByRole("button", { name: "Install plugin…", exact: true })).toHaveCount(0);
  await expect(general.getByLabel("Enable Demo Plugin")).toHaveCount(0);
  await expect(general.getByRole("button", { name: "Open Keyboard Shortcuts" })).toBeVisible();
  await general.locator(".settings-search").fill("Gemini API Key");
  await general.getByRole("button", { name: "Open Plugins", exact: true }).click();
  const plugins = page.getByRole("dialog", { name: "Plugins", exact: true });
  await expect(general).toBeHidden();
  await expect(plugins).toBeVisible();
  await expect(plugins.getByRole("button", { name: "Install plugin…", exact: true })).toBeVisible();
  await expect(plugins.locator(".color-theme-select")).toHaveCount(0);
  await plugins.locator('.settings-section:has(h3:has-text("AI / Destination Suggestions"))').getByLabel("Gemini API Key").fill("settings-menu-test-key");
  await page.keyboard.press("Tab");
  await plugins.getByRole("button", { name: "Close plugins" }).click();
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator(".search-input").fill("Plugins");
  await palette.locator(".command-item").filter({ has: page.locator(".command-label", { hasText: /^Plugins$/ }) }).click();
  await expect(plugins).toBeVisible();
  await expect(plugins.locator('.settings-section:has(h3:has-text("AI / Destination Suggestions"))').getByLabel("Gemini API Key")).toHaveValue("settings-menu-test-key");
  await page.keyboard.press("Escape");
  await expect(plugins).toBeHidden();
  await page.keyboard.press("Control+,");
  await expect(general).toBeVisible();
});

for (const width of [320, 768, 1024, 1440]) {
  test(`Plugins menu fits ${width}px and retains keyboard ownership`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await page.keyboard.press("Control+,");
    await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Plugins", exact: true });
    await expect(dialog).toBeVisible();
    const card = dialog.locator(".plugins-dialog");
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".entry-item").first()).toBeVisible();
  });
}
