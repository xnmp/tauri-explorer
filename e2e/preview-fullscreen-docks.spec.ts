/**
 * E2E: fullscreen image previews from every dock position (#592).
 *
 * The vertical docks persist their size as an inline height. Fullscreen must
 * cover the viewport despite that docked value, then restore the exact dock
 * geometry when it closes.
 */
import { test, expect, type Page } from "./fixtures";
import type { Locator } from "@playwright/test";
import { waitForEntries, pressShortcut } from "./helpers";
import { installLayoutInspector } from "./layout-inspector";

async function openPicturesWithPreview(page: Page): Promise<void> {
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  await installLayoutInspector(page);
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
  test("right dock covers the viewport and restores its original geometry", async ({ page }, testInfo) => {
    await openPicturesWithPreview(page);
    const pane = page.locator(".preview-pane");
    const image = await selectImage(page);
    await expect(page.getByRole("complementary", { name: "File inspector" })).toBeVisible();
    const dockedBox = await pane.boundingBox();
    expect(dockedBox).not.toBeNull();
    await image.click();
    await expect(pane).toHaveClass(/fullscreen/);
    await expectFullscreenViewport(page, pane);
    await page.screenshot({ path: testInfo.outputPath("ac-4-right-fullscreen.png") });

    await page.locator(".preview-image").click();
    await expect(pane).not.toHaveClass(/fullscreen/);
    expect(await pane.boundingBox()).toEqual(dockedBox);
  });

  for (const [dock, command, fullscreenEvidence] of [
    ["bottom", "Dock Preview Pane Bottom", "evidence/ac-1-bottom-fullscreen.png"],
    ["top", "Dock Preview Pane Top", "evidence/ac-2-top-fullscreen.png"],
  ] as const) {
    test(`${dock} dock covers the viewport and restores its original geometry`, async ({ page }, testInfo) => {
      await openPicturesWithPreview(page);
      await dockPreview(page, command);
      const pane = page.locator(".preview-pane");
      const image = await selectImage(page);
      await expect(page.getByRole("complementary", { name: "File inspector" })).toBeVisible();
      const dockedBox = await pane.boundingBox();
      expect(dockedBox).not.toBeNull();
      expect(dockedBox!.height).toBeLessThan(page.viewportSize()!.height);

      await image.click();
      await expect(pane).toHaveClass(/fullscreen/);
      await expectFullscreenViewport(page, pane);
      await page.screenshot({ path: testInfo.outputPath(fullscreenEvidence) });

      await page.locator(".preview-image").click();
      await expect(pane).not.toHaveClass(/fullscreen/);
      expect(await pane.boundingBox()).toEqual(dockedBox);
      if (dock === "top") {
        await page.screenshot({ path: testInfo.outputPath("ac-3-restored-top-dock.png") });
      }
    });
  }
});

/** Layout box of every workspace (explorer) pane, in document order. */
async function workspacePaneRects(page: Page): Promise<DOMRect[]> {
  return page.locator(".explorer-pane").evaluateAll((panes) =>
    panes.map((pane) => pane.getBoundingClientRect().toJSON() as DOMRect));
}

/** Workspace pane rects once they hold for several frames. A window resize
    restacks the inspector a few frames later, docked or fullscreen alike. */
async function settledWorkspacePaneRects(page: Page): Promise<DOMRect[]> {
  return page.evaluate(async () => {
    const read = () => JSON.stringify([...document.querySelectorAll(".explorer-pane")]
      .map((pane) => pane.getBoundingClientRect().toJSON()));
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let last = read();
    for (let frames = 0, stable = 0; stable < 5; frames++) {
      if (frames > 120) throw new Error("workspace panes never settled");
      await frame();
      const next = read();
      stable = next === last ? stable + 1 : 0;
      last = next;
    }
    return JSON.parse(last) as DOMRect[];
  });
}

/* Fullscreen covers the workspace; it must not also resize it. The panes stay
   laid out for the docked preview, so a plugin view under the overlay does not
   reflow for a size it will never be shown at. */
test.describe("Fullscreen preview leaves the workspace panes in place", () => {
  for (const [dock, command] of [
    ["right", null],
    ["bottom", "Dock Preview Pane Bottom"],
    ["top", "Dock Preview Pane Top"],
  ] as const) {
    test(`${dock} dock: workspace panes keep their size through fullscreen`, async ({ page }) => {
      await openPicturesWithPreview(page);
      if (command) await dockPreview(page, command);
      const pane = page.locator(".preview-pane");
      const image = await selectImage(page);
      const docked = await workspacePaneRects(page);
      expect(docked.length).toBeGreaterThan(0);

      await image.click();
      await expect(pane).toHaveClass(/fullscreen/);
      await expectFullscreenViewport(page, pane);
      expect(await workspacePaneRects(page)).toEqual(docked);

      await page.locator(".preview-image").click();
      await expect(pane).not.toHaveClass(/fullscreen/);
      expect(await workspacePaneRects(page)).toEqual(docked);
    });

    test(`${dock} dock: a window resize during fullscreen lays the panes out as if docked`, async ({ page }) => {
      await openPicturesWithPreview(page);
      if (command) await dockPreview(page, command);
      const pane = page.locator(".preview-pane");
      const image = await selectImage(page);
      const viewport = page.viewportSize()!;

      await image.click();
      await expect(pane).toHaveClass(/fullscreen/);
      await page.setViewportSize({ width: viewport.width - 200, height: viewport.height - 120 });
      await expectFullscreenViewport(page, pane);
      const resizedFullscreen = await settledWorkspacePaneRects(page);

      await page.locator(".preview-image").click();
      await expect(pane).not.toHaveClass(/fullscreen/);
      expect(await workspacePaneRects(page)).toEqual(resizedFullscreen);
    });
  }
});
