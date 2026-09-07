import { expect, test, type Page } from "./fixtures";
import { switchViewMode, waitForEntries } from "./helpers";

const HOME = "/?path=/home/user";

async function runListColumnPicker(page: Page): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await expect(palette).toBeVisible();
  await palette.locator(".search-input").fill("Set List View Column Count");
  await palette
    .locator('.command-item:has-text("Set List View Column Count")')
    .first()
    .click();

  const picker = page.locator(".option-picker-dialog");
  await expect(picker).toBeVisible();
  await picker.locator('.option-picker-item:has-text("4 Columns")').click();
  await expect(picker).toBeHidden();
}

function seedPersistedSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  return page.addInitScript((persisted) => {
    localStorage.setItem(
      "mock-config-files",
      JSON.stringify({ "settings.json": JSON.stringify(persisted) }),
    );
  }, settings);
}

test.describe("Numeric settings outcomes", () => {
  test("4 Columns renders four List tracks and keeps selection/navigation usable", async ({
    page,
  }, testInfo) => {
    await page.goto(HOME);
    await waitForEntries(page);
    await switchViewMode(page, "list");
    await runListColumnPicker(page);

    const list = page.locator(".list-view");
    await expect(list).toHaveAttribute("data-columns", "4");
    const tracks = await page.locator(".list-row").first().evaluate((row) =>
      getComputedStyle(row).gridTemplateColumns.split(" ").filter(Boolean),
    );
    expect(tracks).toHaveLength(4);

    const documents = page.locator('.entry-item[data-path="/home/user/Documents"]');
    await documents.click();
    await expect(documents).toHaveClass(/selected/);

    if (testInfo.project.name === "chromium") {
      await page.screenshot({
        path: "screenshots/refactor/repo-health-cleanup/numeric-settings.png",
      });
    }

    await documents.dblclick();
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/project"]')).toBeVisible();
    await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toHaveCount(0);
  });

  test("malformed persisted column and preview widths normalize to a usable layout", async ({
    page,
  }) => {
    await seedPersistedSettings(page, {
      listViewColumns: 2.5,
      previewPaneWidth: 1,
      showPreviewPane: true,
    });
    await page.goto(HOME);
    await waitForEntries(page);
    await switchViewMode(page, "list");

    const list = page.locator(".list-view");
    await expect(list).toHaveAttribute("data-columns", "3");

    await page.locator('.entry-item[data-path="/home/user/notes.md"]').click();
    const preview = page.locator(".preview-pane");
    await expect(preview).toBeVisible();
    await expect(preview.locator(".preview-markdown")).toBeVisible();
    const box = await preview.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(278);
  });
});
