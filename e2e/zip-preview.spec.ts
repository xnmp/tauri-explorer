/**
 * ZIP file preview: a selected .zip previews its top-level contents in the
 * same folder-list format as a directory preview. Asserts on the actual
 * rendered entries (the outcome), not just that the pane opened.
 */

import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

test.describe("ZIP preview", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user/Downloads");
    await waitForEntries(page);

    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) {
      await pressShortcut(page, " ", {});
    }
    await expect(previewPane).toBeVisible();
  });

  test("selecting a .zip renders its contents in the folder-list format", async ({ page }) => {
    await page.locator(".entry-item", { hasText: "archive.zip" }).first().click();

    // Same component a folder preview uses.
    const list = page.locator(".preview-folder-list");
    await expect(list).toBeVisible();

    const names = list.locator(".folder-item-name");
    await expect(names).toHaveCount(3);
    await expect(names.nth(0)).toHaveText("src");
    await expect(names.nth(1)).toHaveText("README.md");
    await expect(names.nth(2)).toHaveText("data.json");

    // Directory entries get the folder styling, files don't.
    await expect(list.locator(".folder-item.is-directory")).toHaveCount(1);

    // The archive is labeled as a zipped folder, and it's NOT shown as text.
    await expect(page.locator(".preview-type-badge")).toHaveText(/zipped/i);
    await expect(page.locator(".preview-text")).toHaveCount(0);
    // Multiple top-level entries → no single-root-folder indicator.
    await expect(page.locator(".collapsed-root-indicator")).toHaveCount(0);
  });

  test("a zip with a single top-level folder descends into it and shows the indicator", async ({ page }) => {
    await page.goto("/?path=/home/user/Downloads");
    await waitForEntries(page);

    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) {
      await pressShortcut(page, " ", {});
    }
    await expect(previewPane).toBeVisible();

    await page.locator(".entry-item", { hasText: "bundle.zip" }).first().click();

    // The indicator names the lone top-level folder.
    const indicator = page.locator(".collapsed-root-indicator");
    await expect(indicator).toBeVisible();
    await expect(indicator.locator(".collapsed-root-name")).toHaveText("bundle/");
    await expect(indicator).toContainText(/single top-level folder/i);

    // The list shows that folder's CONTENTS (descended), not just "bundle".
    const names = page.locator(".preview-folder-list .folder-item-name");
    await expect(names).toHaveCount(3);
    await expect(names.nth(0)).toHaveText("src");
    await expect(names.nth(1)).toHaveText("Cargo.toml");
    await expect(names.nth(2)).toHaveText("main.rs");
    await expect(page.locator(".folder-item-name", { hasText: "bundle" })).toHaveCount(0);
  });

  test("a folder that is a chain of single subfolders descends to real content", async ({ page }) => {
    // wrapper → payload → inner → {assets, app.js, style.css}: previewing the
    // wrapper folder should descend the whole chain, like the zip case does.
    await page.locator(".entry-item .entry-name", { hasText: "wrapper" }).first().click();

    const indicator = page.locator(".collapsed-root-indicator");
    await expect(indicator).toBeVisible();
    // The collapsed path names every folder we descended through.
    await expect(indicator.locator(".collapsed-root-name")).toHaveText("payload/inner/");
    await expect(indicator).toContainText(/single-folder chain/i);

    // The list shows inner's CONTENTS, not the intermediate folders.
    const names = page.locator(".preview-folder-list .folder-item-name");
    await expect(names).toHaveCount(3);
    await expect(names.nth(0)).toHaveText("assets");
    await expect(names.nth(1)).toHaveText("app.js");
    await expect(names.nth(2)).toHaveText("style.css");
    await expect(page.locator(".folder-item-name", { hasText: "payload" })).toHaveCount(0);
  });
});
