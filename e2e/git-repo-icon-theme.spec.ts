/**
 * Git repository badges are a rendered theme surface, not a fixed Git-brand
 * colour. The mock listing deliberately includes `my-project` as a repository
 * root beside ordinary folders, so this test observes the actual SVG badge a
 * user sees after changing themes.
 */
import { test, expect } from "./fixtures";
import { waitForEntries, HOME_URL } from "./helpers";

async function setTheme(page: import("@playwright/test").Page, theme: string) {
  await page.keyboard.press("Control+,");
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".color-theme-select").selectOption(theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await dialog.locator(".close-btn").click();
  await expect(dialog).toBeHidden();
}

test("Git repository folder badge follows the active theme", async ({ page }) => {
  await page.goto(HOME_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await waitForEntries(page);

  const repository = page.locator('.entry-item[data-path="/home/user/my-project"]');
  const badge = repository.locator(".git-repo-folder svg > circle");
  const folder = page.locator('.entry-item[data-path="/home/user/Documents"] svg path').first();
  await expect(badge).toBeVisible();

  await setTheme(page, "light");
  const lightBadge = await badge.evaluate((element) => getComputedStyle(element).fill);
  const lightFolder = await folder.evaluate((element) => getComputedStyle(element).fill);
  expect(lightBadge).not.toBe(lightFolder);
  await page.screenshot({ path: "evidence/ac-1-light-theme-git-badge.png" });

  await setTheme(page, "dark");
  const darkBadge = await badge.evaluate((element) => getComputedStyle(element).fill);
  const darkFolder = await folder.evaluate((element) => getComputedStyle(element).fill);
  expect(darkBadge).not.toBe(darkFolder);
  expect(darkBadge).not.toBe(lightBadge);
  await page.screenshot({ path: "evidence/ac-2-dark-theme-git-badge.png" });

  await setTheme(page, "hacker");
  const hackerBadge = await badge.evaluate((element) => getComputedStyle(element).fill);
  const hackerFolder = await folder.evaluate((element) => getComputedStyle(element).fill);
  expect(hackerBadge).not.toBe(hackerFolder);
  expect(hackerBadge).not.toBe(darkBadge);
  await page.screenshot({ path: "evidence/ac-3-theme-change-git-badge.png" });
});
