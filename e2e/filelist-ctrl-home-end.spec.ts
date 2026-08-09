import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

const PROJECT_URL = "/?path=/home/user/Documents/project";

function selectedEntry(page: Page) {
  return page.locator(".entry-item.selected");
}

test.describe("File list Ctrl+Home and Ctrl+End navigation", () => {
  test("Ctrl+End selects and reveals the final entry from an existing selection", async ({ page }) => {
    await page.goto(PROJECT_URL);
    await waitForEntries(page);

    await page.locator(".entry-item").first().click();
    await page.keyboard.press("Control+End");

    await expect(selectedEntry(page)).toHaveText("tsconfig.json");
    await expect(selectedEntry(page)).toBeInViewport();
    await page.screenshot({ path: "evidence/ac-1-ctrl-end-final-entry.png" });
  });

  test("Ctrl+Home selects and reveals the first entry from an existing selection", async ({ page }) => {
    await page.goto(PROJECT_URL);
    await waitForEntries(page);

    await page.locator(".entry-item").last().click();
    await page.keyboard.press("Control+Home");

    await expect(selectedEntry(page)).toHaveText("assets");
    await expect(selectedEntry(page)).toBeInViewport();
    await page.screenshot({ path: "evidence/ac-2-ctrl-home-first-entry.png" });
  });

  test("Ctrl+Home and Ctrl+End leave an empty pane without a selection", async ({ page }) => {
    await page.goto("/?path=/home/user/Archive");
    await expect(page.locator(".empty-state")).toBeVisible();

    await page.keyboard.press("Control+End");
    await page.keyboard.press("Control+Home");

    await expect(selectedEntry(page)).toHaveCount(0);
    await page.screenshot({ path: "evidence/ac-3-empty-pane-no-selection.png" });
  });

  test("Ctrl+End selects the final entry when nothing is selected", async ({ page }) => {
    await page.goto(PROJECT_URL);
    await waitForEntries(page);
    await page.keyboard.press("Escape");
    await expect(selectedEntry(page)).toHaveCount(0);

    await page.keyboard.press("Control+End");

    await expect(selectedEntry(page)).toHaveText("tsconfig.json");
    await expect(selectedEntry(page)).toBeInViewport();
    await page.screenshot({ path: "evidence/ac-4-unselected-ctrl-end.png" });
  });
});
