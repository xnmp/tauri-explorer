/**
 * E2E: fullscreen image previews from every dock position (#592).
 *
 * The vertical docks persist their size as an inline height. Fullscreen must
 * cover the viewport despite that docked value, then restore the exact dock
 * geometry when it closes.
 */
import { test, expect, type Locator, type Page } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

async function openPicturesWithPreview(page: Page): Promise<void> {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  const previewPane = page.locator(".preview-pane");
  if (!(await previewPane.isVisible())) {
    await pressShortcut(page, " ", {});
  }
  await expect(previewPane).toBeVisible();
}

async function dockPreview(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await expect(palette).toBeVisible();
  await palette.locator(".search-input").fill(label);
  await palette.locator(`.command-item:has-text("${label}")`).first().click();
  await expect(palette).toBeHidden();
}

async function selectImage(page: Page): Promise<Locator> {
  await page.locator(".entry-item").filter({ hasText: "photo1.jpg" }).first().click();
  const image = page.locator(".preview-image");
  await expect(image).toBeVisible();
  return image;
}

async function expectFullscreenViewport(page: Page, pane: Locator): Promise<void> {
  const fullscreenBox = await pane.boundingBox();
  const viewport = page.viewportSize()!;
  expect(fullscreenBox).not.toBeNull();
  expect(fullscreenBox!.x).toBe(0);
  expect(fullscreenBox!.y).toBe(0);
  expect(fullscreenBox!.width).toBe(viewport.width);
  expect(fullscreenBox!.height).toBe(viewport.height);
}

test.describe("Fullscreen preview dock geometry", () => {
  test("right dock covers the viewport and restores its original geometry", async ({ page }) => {
    await openPicturesWithPreview(page);
    const pane = page.locator(".preview-pane");
    const dockedBox = await pane.boundingBox();
    expect(dockedBox).not.toBeNull();

    const image = await selectImage(page);
    await image.click();
    await expect(pane).toHaveClass(/fullscreen/);
    await expectFullscreenViewport(page, pane);
    await page.screenshot({ path: "evidence/ac-4-right-fullscreen.png" });

    await page.locator(".preview-image").click();
    await expect(pane).not.toHaveClass(/fullscreen/);
    expect(await pane.boundingBox()).toEqual(dockedBox);
  });

  for (const [dock, command, fullscreenEvidence] of [
    ["bottom", "Dock Preview Pane Bottom", "evidence/ac-1-bottom-fullscreen.png"],
    ["top", "Dock Preview Pane Top", "evidence/ac-2-top-fullscreen.png"],
  ] as const) {
    test(`${dock} dock covers the viewport and restores its original geometry`, async ({ page }) => {
      await openPicturesWithPreview(page);
      await dockPreview(page, command);
      const pane = page.locator(".preview-pane");
      const dockedBox = await pane.boundingBox();
      expect(dockedBox).not.toBeNull();
      expect(dockedBox!.height).toBeLessThan(page.viewportSize()!.height);

      const image = await selectImage(page);
      await image.click();
      await expect(pane).toHaveClass(/fullscreen/);
      await expectFullscreenViewport(page, pane);
      await page.screenshot({ path: fullscreenEvidence });

      await page.locator(".preview-image").click();
      await expect(pane).not.toHaveClass(/fullscreen/);
      expect(await pane.boundingBox()).toEqual(dockedBox);
      if (dock === "top") {
        await page.screenshot({ path: "evidence/ac-3-restored-top-dock.png" });
      }
    });
  }
});
