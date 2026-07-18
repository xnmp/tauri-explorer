/**
 * E2E: preview pane dock position — right / bottom / top (#460).
 *
 * Outcome-based: asserts the preview pane's bounding box lands on the correct
 * side of the file list after cycling via the command palette, that the file
 * list stays populated in every orientation, and that a vertical resize drag
 * persists across reload.
 */

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { waitForEntries, pressShortcut } from "./helpers";

async function runPaletteCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.waitFor({ state: "visible", timeout: 2000 });
  await palette.locator(".search-input").fill(label);
  const cmd = palette.locator(`.command-item:has-text("${label}")`).first();
  await expect(cmd).toBeVisible();
  await cmd.click();
  await expect(palette).toBeHidden();
}

async function boxes(page: Page) {
  const list = await page.locator(".file-list").first().boundingBox();
  const preview = await page.locator(".preview-pane").boundingBox();
  expect(list).not.toBeNull();
  expect(preview).not.toBeNull();
  return { list: list!, preview: preview! };
}

test.describe("Preview pane dock position", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForEntries(page);

    // Reveal the preview pane and give it real content by selecting a file.
    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) {
      await pressShortcut(page, " ", {});
    }
    await expect(previewPane).toBeVisible();
    await page.locator(".entry-item", { hasText: "notes.md" }).first().click();
    await expect(page.locator(".preview-markdown")).toBeVisible();
  });

  test("cycles right -> bottom -> top -> right, positioning the pane correctly", async ({ page }) => {
    // Default: docked right — preview sits to the right of the file list.
    {
      const { list, preview } = await boxes(page);
      expect(preview.x).toBeGreaterThan(list.x + list.width / 2);
      await expect(page.locator(".entry-item").first()).toBeVisible();
    }

    // Cycle -> bottom: preview below the file list, still full content.
    await runPaletteCommand(page, "Cycle Preview Pane Position");
    {
      const { list, preview } = await boxes(page);
      expect(preview.y).toBeGreaterThan(list.y + list.height / 2);
      await expect(page.locator(".preview-markdown")).toBeVisible();
      await expect(page.locator(".entry-item").first()).toBeVisible();
    }

    // Cycle -> top: preview above the file list.
    await runPaletteCommand(page, "Cycle Preview Pane Position");
    {
      const { list, preview } = await boxes(page);
      expect(preview.y + preview.height).toBeLessThan(list.y + list.height / 2);
      await expect(page.locator(".entry-item").first()).toBeVisible();
    }

    // Cycle -> right again.
    await runPaletteCommand(page, "Cycle Preview Pane Position");
    {
      const { list, preview } = await boxes(page);
      expect(preview.x).toBeGreaterThan(list.x + list.width / 2);
      await expect(page.locator(".entry-item").first()).toBeVisible();
    }
  });

  test("direct 'Dock Preview Pane Bottom' command docks below", async ({ page }) => {
    await runPaletteCommand(page, "Dock Preview Pane Bottom");
    const { list, preview } = await boxes(page);
    expect(preview.y).toBeGreaterThan(list.y + list.height / 2);
  });

  test("vertical resize in bottom dock changes height and persists across reload", async ({ page }) => {
    await runPaletteCommand(page, "Dock Preview Pane Bottom");

    const previewPane = page.locator(".preview-pane");
    const handle = previewPane.locator(".resize-handle");

    // Handle is a row-resize bar on the pane's top edge.
    const cursor = await handle.evaluate((el) => getComputedStyle(el).cursor);
    expect(cursor).toBe("row-resize");

    const before = await previewPane.boundingBox();
    expect(before).not.toBeNull();

    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;

    // Drag up 90px → taller pane (handle on top edge, dragging up grows it).
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY - 90, { steps: 5 });
    await page.mouse.up();

    const after = await previewPane.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.height).toBeGreaterThan(before!.height + 40);

    const persisted = await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      return raw ? JSON.parse(raw) : null;
    });
    expect(persisted).not.toBeNull();
    expect(persisted.previewPaneHeight).toBeGreaterThan(0);
    expect(persisted.previewPanePosition).toBe("bottom");

    // Survives a reload.
    await page.reload();
    await waitForEntries(page);
    const reloaded = await previewPane.boundingBox();
    expect(reloaded).not.toBeNull();
    expect(reloaded!.height).toBeGreaterThan(before!.height + 40);
  });
});
