import { expect, test, type Page } from "./fixtures";
import { switchViewMode, waitForEntries } from "./helpers";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";

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
  return page.addInitScript(({ persisted, configSeedKey }) => {
    localStorage.setItem(
      configSeedKey,
      JSON.stringify({ "settings.json": JSON.stringify(persisted) }),
    );
  }, { persisted: settings, configSeedKey: MOCK_LOCAL_KEYS.configSeed });
}

test.describe("Numeric settings outcomes", () => {
  test("legacy List columns stay readable but height determines the flow", async ({ page }) => {
    await seedPersistedSettings(page, { listViewColumns: 4, listColumnMaxWidth: 100 });
    await page.goto("/?path=/perf/huge-100&viewMode=list");
    await waitForEntries(page);
    expect(await page.evaluate(async () => {
      const { settingsStore } = await import('/src/lib/state/settings.svelte.ts');
      return [settingsStore.listViewColumns,settingsStore.listColumnMaxWidth];
    })).toEqual([4,100]);
    const rows = await page.locator(".list-view").getAttribute("data-rows");
    const firstColumn = page.locator('.list-slot[data-column="0"] .entry-item');
    await expect(firstColumn).toHaveCount(Number(rows));
    await expect(page.locator(".list-item").first()).toHaveCSS("width", "260px");
    await page.setViewportSize({ width: 1280, height: 500 });
    await expect.poll(() => page.locator(".list-view").getAttribute("data-rows")).not.toBe(rows);
    await firstColumn.first().click();
    await expect(firstColumn.first()).toHaveClass(/selected/);
    await firstColumn.first().dblclick();
    await expect(page.locator('.content[data-current-path="/perf/huge-100/folder-00000"]')).toBeVisible();
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
    expect(Number(await list.getAttribute("data-rows"))).toBeGreaterThanOrEqual(4);
    await expect(page.locator(".list-item").first()).toHaveCSS("width", "260px");

    await page.locator('.entry-item[data-path="/home/user/notes.md"]').click();
    const preview = page.locator(".preview-pane");
    await expect(preview).toBeVisible();
    await expect(preview.locator(".preview-markdown")).toBeVisible();
    const box = await preview.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(278);
  });

  // Folder Peek off restores the classic row-major List and its column controls.
  test.describe("classic List (Folder Peek off)", () => {
    test("4 Columns renders four List tracks and keeps selection/navigation usable", async ({ page }) => {
      await seedPersistedSettings(page, { folderPeek: false });
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
      await documents.dblclick();
      await expect(page.locator('.entry-item[data-path="/home/user/Documents/project"]')).toBeVisible();
      await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toHaveCount(0);
    });

    test("malformed persisted column and preview widths normalize to a usable layout", async ({ page }) => {
      await seedPersistedSettings(page, {
        folderPeek: false,
        listViewColumns: 2.5,
        previewPaneWidth: 1,
        showPreviewPane: true,
      });
      await page.goto(HOME);
      await waitForEntries(page);
      await switchViewMode(page, "list");

      await expect(page.locator(".list-view")).toHaveAttribute("data-columns", "3");

      await page.locator('.entry-item[data-path="/home/user/notes.md"]').click();
      const preview = page.locator(".preview-pane");
      await expect(preview).toBeVisible();
      await expect(preview.locator(".preview-markdown")).toBeVisible();
      const box = await preview.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(278);
    });
  });
});
