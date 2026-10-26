/** Command palette synonyms (#1247): "hotkeys" finds Keyboard Shortcuts. */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test("typing a synonym in the palette lists the keyboard shortcuts command", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.waitFor({ state: "visible" });
  await palette.locator(".search-input").fill("hotkeys");
  await expect(palette.locator('.command-item:has-text("Keyboard Shortcuts")')).toBeVisible();
  await page.screenshot({ path: "screenshots/feat/synonyms/palette-hotkeys.png", animations: "disabled" });
});
