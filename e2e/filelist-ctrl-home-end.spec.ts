import { test, expect, type Page } from "./fixtures";
import { VIEW_MODES, waitForEntries } from "./helpers";

const PROJECT_URL = "/?path=/home/user/Documents/project";

function selectedEntry(page: Page) {
  return page.locator(".entry-item.selected");
}

for (const viewMode of VIEW_MODES) {
test.describe(`File list Ctrl+Home and Ctrl+End navigation [${viewMode}]`, () => {
  async function openProject(page: Page): Promise<void> {
    await page.goto(PROJECT_URL);
    await waitForEntries(page);
    if (viewMode === "details") return;

    // Switch with the command palette because a dense virtualized list may
    // leave no reliable empty area for the background context-menu helper.
    await page.keyboard.press("Control+Shift+p");
    const palette = page.locator(".command-palette-dialog");
    await expect(palette).toBeVisible();
    await palette.locator(".search-input").fill(`${viewMode} View`);
    await palette.locator(".command-item").first().click();
    await expect(page.locator(`.${viewMode}-view`)).toBeVisible();
  }

  test("Ctrl+End selects and reveals the final entry from an existing selection", async ({ page }) => {
    await openProject(page);

    await page.locator(".entry-item").first().click();
    await page.keyboard.press("Control+End");

    await expect(selectedEntry(page).locator(".entry-name")).toHaveText("tsconfig.json");
    await expect(selectedEntry(page)).toBeInViewport();
    if (viewMode === "details") await page.screenshot({ path: "evidence/ac-1-ctrl-end-final-entry.png" });
  });

  test("Ctrl+Home selects and reveals the first entry from an existing selection", async ({ page }) => {
    await openProject(page);

    await page.locator(".entry-item").last().click();
    await page.keyboard.press("Control+Home");

    await expect(selectedEntry(page).locator(".entry-name")).toHaveText("assets");
    await expect(selectedEntry(page)).toBeInViewport();
    if (viewMode === "details") await page.screenshot({ path: "evidence/ac-2-ctrl-home-first-entry.png" });
  });

  test("Ctrl+Home and Ctrl+End leave an empty pane without a selection", async ({ page }) => {
    await page.goto("/?path=/home/user/Archive");
    await expect(page.locator(".empty-state")).toBeVisible();

    await page.keyboard.press("Control+End");
    await page.keyboard.press("Control+Home");

    await expect(selectedEntry(page)).toHaveCount(0);
    if (viewMode === "details") await page.screenshot({ path: "evidence/ac-3-empty-pane-no-selection.png" });
  });

  test("Ctrl+End selects the final entry when nothing is selected", async ({ page }) => {
    await openProject(page);
    await page.keyboard.press("Escape");
    await expect(selectedEntry(page)).toHaveCount(0);

    await page.keyboard.press("Control+End");

    await expect(selectedEntry(page).locator(".entry-name")).toHaveText("tsconfig.json");
    await expect(selectedEntry(page)).toBeInViewport();
    if (viewMode === "details") await page.screenshot({ path: "evidence/ac-4-unselected-ctrl-end.png" });
  });

  test("Ctrl+Home selects the first entry when nothing is selected", async ({ page }) => {
    await openProject(page);
    await page.keyboard.press("Escape");
    await expect(selectedEntry(page)).toHaveCount(0);

    await page.keyboard.press("Control+Home");

    await expect(selectedEntry(page).locator(".entry-name")).toHaveText("assets");
    await expect(selectedEntry(page)).toBeInViewport();
    if (viewMode === "details") await page.screenshot({ path: "evidence/ac-4-unselected-ctrl-home.png" });
  });
});
}
