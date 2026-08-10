/**
 * Git repository badges are a rendered theme surface, not a fixed Git-brand
 * colour. The mock listing deliberately includes `my-project` as a repository
 * root beside ordinary folders, so this test observes the actual SVG badge a
 * user sees after changing themes.
 */
import { test, expect } from "./fixtures";
import { VIEW_MODES, waitForEntries, HOME_URL, switchViewMode } from "./helpers";

async function setTheme(page: import("@playwright/test").Page, theme: string) {
  await page.keyboard.press("Control+,");
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".color-theme-select").selectOption(theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await dialog.locator(".close-btn").click();
  await expect(dialog).toBeHidden();
}

async function renderedFolderColour(folder: import("@playwright/test").Locator) {
  return folder.evaluate((element) => {
    const styles = getComputedStyle(element);
    return styles.stroke !== "none" ? styles.stroke : styles.fill;
  });
}

for (const viewMode of VIEW_MODES) {
test(`Git repository folder badge follows the active theme in ${viewMode} view`, async ({ page }) => {
  await page.goto(HOME_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await waitForEntries(page);
  if (viewMode !== "details") await switchViewMode(page, viewMode);

  const repository = page.locator('.entry-item[data-path="/home/user/my-project"]');
  const badge = repository.locator(".git-repo-folder svg > circle");
  const folder = page.locator('.entry-item[data-path="/home/user/Documents"] svg path').first();
  await expect(badge).toBeVisible();

  await setTheme(page, "light");
  const lightBadge = await badge.evaluate((element) => getComputedStyle(element).fill);
  const lightFolder = await renderedFolderColour(folder);
  expect(lightBadge).not.toBe(lightFolder);
  if (viewMode === "tiles") {
    await page.screenshot({ path: "evidence/ac-1-light-theme-git-badge.png" });
  }

  await setTheme(page, "dark");
  const darkBadge = await badge.evaluate((element) => getComputedStyle(element).fill);
  const darkFolder = await renderedFolderColour(folder);
  expect(darkBadge).not.toBe(darkFolder);
  expect(darkBadge).not.toBe(lightBadge);
  if (viewMode === "tiles") {
    await page.screenshot({ path: "evidence/ac-2-dark-theme-git-badge.png" });
  }

  await setTheme(page, "aurora");
  const auroraBadge = await badge.evaluate((element) => getComputedStyle(element).fill);
  const auroraFolder = await renderedFolderColour(folder);
  expect(auroraBadge).not.toBe(auroraFolder);
  expect(auroraBadge).not.toBe(darkBadge);
  if (viewMode === "tiles") {
    await page.screenshot({ path: "evidence/ac-3-theme-change-git-badge.png" });
  }

  await setTheme(page, "hacker");
  const hackerBadge = await badge.evaluate((element) => getComputedStyle(element).fill);
  const hackerFolder = await renderedFolderColour(folder);
  expect(hackerBadge).not.toBe(hackerFolder);
  expect(hackerBadge).not.toBe(darkBadge);
});
}
