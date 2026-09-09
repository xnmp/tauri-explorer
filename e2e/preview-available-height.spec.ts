/**
 * E2E: a restored vertical preview must not cover the file area at UI zoom.
 *
 * The saved preference is model-space CSS pixels. At 150% root zoom, rendering
 * its raw 600px value consumed a 900px visual window and made file entries
 * impossible to select (#699).
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, waitForEntries, type ViewMode } from "./helpers";

const DOCKS = ["bottom", "top"] as const;
const VIEW_MODES: readonly ViewMode[] = ["details", "list", "tiles"];

async function restoreConstrainedPreview(page: Page, dock: (typeof DOCKS)[number]): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(HOME_URL);
  await page.evaluate(({ dock }) => {
    localStorage.setItem(
      "explorer-settings",
      JSON.stringify({
        showPreviewPane: true,
        previewPanePosition: dock,
        previewPaneHeight: 600,
        zoomLevel: 150,
      }),
    );
  }, { dock });
  await page.reload();
  await waitForEntries(page);
  await expect(page.locator(".preview-pane")).toBeVisible();
}

async function selectReachableFile(page: Page): Promise<void> {
  const entry = page.locator(".entry-item", { hasText: "notes.md" }).first();
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(entry).toHaveClass(/selected/);
  await expect(page.locator(".preview-markdown")).toBeVisible();

  const hitEntry = await entry.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit?.closest(".entry-item") === element;
  });
  expect(hitEntry).toBe(true);
}

async function selectViewMode(page: Page, viewMode: ViewMode): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await expect(palette).toBeVisible();
  await palette.locator(".search-input").fill(`${viewMode} View`);
  await palette.locator(".command-item").first().click();
  await expect(page.locator(`.${viewMode}-view`)).toBeVisible();
}

async function expectUsableVerticalLayout(page: Page): Promise<void> {
  const list = page.locator(".file-list").first();
  const pane = page.locator(".preview-pane");
  const handle = pane.locator(".resize-handle");
  await expect(list).toBeVisible();
  await expect(handle).toBeVisible();

  const [listBox, handleBox, viewport] = await Promise.all([
    list.boundingBox(),
    handle.boundingBox(),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
  ]);
  expect(listBox).not.toBeNull();
  expect(handleBox).not.toBeNull();
  expect(listBox!.height).toBeGreaterThan(100);
  expect(handleBox!.y).toBeGreaterThanOrEqual(0);
  expect(handleBox!.y + handleBox!.height).toBeLessThanOrEqual(viewport.height);
}

test.describe("restored vertical preview allocation", () => {
  for (const dock of DOCKS) {
    test(`${dock} dock preserves real file selection in every view at 150% zoom`, async ({ page }) => {
      await restoreConstrainedPreview(page, dock);

      for (const viewMode of VIEW_MODES) {
        await selectViewMode(page, viewMode);
        await expectUsableVerticalLayout(page);
        await selectReachableFile(page);
        if (dock === "bottom") {
          await page.screenshot({ path: `evidence/ac-${VIEW_MODES.indexOf(viewMode) + 1}-bottom-${viewMode}-selection.png` });
        } else if (viewMode === "details") {
          await page.screenshot({ path: "evidence/ac-4-top-dock-selection.png" });
        }
      }
    });
  }

  test("returns to the saved vertical height when a constrained window grows", async ({ page }) => {
    await restoreConstrainedPreview(page, "bottom");
    await expectUsableVerticalLayout(page);

    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      return raw ? JSON.parse(raw).previewPaneHeight : null;
    }).then((savedHeight) => expect(savedHeight).toBe(600));

    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.evaluate(() => document.documentElement.style.zoom = "100%");
    await expect.poll(async () => (await page.locator(".preview-pane").boundingBox())?.height ?? 0).toBeGreaterThan(590);
    await page.screenshot({ path: "evidence/ac-5-restored-preferred-height.png" });
  });
});
