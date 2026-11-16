/**
 * The commit graph is an experimental, opt-in feature (#1675): a fresh profile
 * shows the flag off and offers no graph command until the user enables it.
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

const SHOTS = "screenshots/feat/git-graph-off-by-default";

test("a fresh profile keeps the commit graph off until enabled in Settings", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);

  const palette = page.locator(".command-palette-dialog");
  const graphCommand = palette.locator(".command-item", { hasText: "Git: Toggle Commit Graph" });

  await page.keyboard.press("Control+Shift+p");
  await palette.locator(".search-input").fill("Toggle Commit Graph");
  await expect(graphCommand).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.keyboard.press("Control+,");
  const settings = page.locator(".settings-dialog");
  await settings.locator(".settings-search").fill("Git Commit Graph");
  const row = settings.locator(".setting-row", { hasText: "Git Commit Graph" });
  const toggle = row.locator("input[type=checkbox]");
  await expect(toggle).not.toBeChecked();
  await page.screenshot({ path: `${SHOTS}/settings-experimental-git-graph-off.png`, animations: "disabled" });

  await row.locator(".toggle-slider").click();
  await expect(toggle).toBeChecked();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(settings).toBeHidden();

  await page.keyboard.press("Control+Shift+p");
  await palette.locator(".search-input").fill("Toggle Commit Graph");
  await expect(graphCommand).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="git-graph-view"] .commit-row').first()).toBeVisible();
});
