import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

const backButton = 'button[aria-label="Go back"]';
const forwardButton = 'button[aria-label="Go forward"]';

test("navigation tooltips advertise the default command bindings", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);

  await expect(page.locator(backButton)).toHaveAttribute(
    "title",
    "Back (Ctrl+Alt+←) — right-click for history",
  );
  await expect(page.locator(forwardButton)).toHaveAttribute(
    "title",
    "Forward (Ctrl+Alt+→) — right-click for history",
  );
});

test("custom shortcuts are advertised and navigate the visible folder history", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("explorer-keybindings", JSON.stringify({
      "navigation.goBack": "Ctrl+Shift+B",
      "navigation.goForward": "Ctrl+Shift+G",
    }));
  });
  await page.goto(HOME_URL);
  await waitForEntries(page);

  await expect(page.locator(backButton)).toHaveAttribute(
    "title",
    "Back (Ctrl+Shift+B) — right-click for history",
  );
  await expect(page.locator(forwardButton)).toHaveAttribute(
    "title",
    "Forward (Ctrl+Shift+G) — right-click for history",
  );

  const breadcrumbs = page.locator(".breadcrumbs-container");
  const initialPath = await breadcrumbs.textContent();
  const folder = page.locator(".entry-item.directory").first();
  const folderName = await folder.locator(".entry-name").textContent();
  expect(folderName).toBeTruthy();

  await folder.dblclick();
  await expect(breadcrumbs).toContainText(folderName!);

  await page.keyboard.press("Control+Shift+b");
  await expect(breadcrumbs).toHaveText(initialPath ?? "");

  await page.keyboard.press("Control+Shift+g");
  await expect(breadcrumbs).toContainText(folderName!);
});
