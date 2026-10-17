import { expect, test, type Page } from "./fixtures";
import { switchViewMode, waitForEntries } from "./helpers";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";

const HOME = "/?path=/home/user";

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
});
