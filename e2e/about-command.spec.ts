import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

// Exercise the production palette/command/dialog path. get_app_info is an
// existing backend contract; the browser backend returns version 0.0.0-mock.
test("About shows the running app version and supports dismissal/reopening @smoke", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  const about = page.getByRole("dialog", { name: "About Tauri Explorer", exact: true });

  async function searchAbout() {
    await page.keyboard.press("Control+Shift+p");
    await expect(palette).toBeVisible();
    await palette.getByPlaceholder("Type a command...").fill("About");
    await expect(palette.getByRole("option").filter({ hasText: "About" })).toHaveCount(1);
    await expect(palette.locator(".command-label")).toHaveText("About");
  }

  await searchAbout();
  await page.screenshot({ path: "evidence/ac-1-about-command.png", animations: "disabled" });
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(about).toBeVisible();
  await expect(about.getByText("Version 0.0.0-mock", { exact: true })).toBeVisible();
  await page.screenshot({ path: "evidence/ac-2-about-version.png", animations: "disabled" });
  await page.keyboard.press("Escape");
  await expect(about).toBeHidden();

  await searchAbout();
  await palette.getByRole("option").filter({ hasText: "About" }).click();
  await expect(about.getByText("Version 0.0.0-mock", { exact: true })).toBeVisible();
  await about.getByRole("button", { name: "Close", exact: true }).click();
  await expect(about).toBeHidden();

  await searchAbout();
  await page.keyboard.press("Enter");
  await expect(about.getByText("Version 0.0.0-mock", { exact: true })).toBeVisible();
  await about.click({ position: { x: 5, y: 5 } });
  await expect(about).toBeHidden();
});
