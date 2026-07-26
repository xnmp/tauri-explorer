/**
 * E2E: "Preview Info" setting — hide the auxiliary metadata in the preview
 * pane (file name, type badge, size, modified date). Issue #494.
 *
 * This is the observable seam for the feature: it asserts on the rendered
 * preview-pane DOM, which is what a user actually sees, rather than on the
 * setting value. Screenshots are captured as a side-effect of the assertions
 * so the evidence images can't drift from what the test proved.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

const PROJECT_URL = "/?path=/home/user/Documents/project";
const TOGGLE = '[data-testid="setting-show-preview-info"]';

/** Open the preview pane (Space) and select a file in it. */
async function openPreviewFor(page: Page, name: string) {
  const previewPane = page.locator(".preview-pane");
  if (!(await previewPane.isVisible())) {
    await pressShortcut(page, " ", {});
    await expect(previewPane).toBeVisible();
  }
  await page.locator(".entry-item", { hasText: name }).first().click();
  await expect(page.locator(".preview-pane .preview-content")).toBeVisible({ timeout: 5000 });
}

/**
 * Open Settings, filter down to the Preview Info row and return its parts.
 * The checkbox itself is visually collapsed (`.toggle input` is 0×0 with
 * opacity 0) — the clickable surface is the slider, so click that and read
 * state off the input.
 */
async function openPreviewInfoSetting(page: Page) {
  await page.evaluate(() =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true }),
    ),
  );
  const search = page.locator(".settings-search");
  await expect(search).toBeVisible();
  await search.fill("Preview Info");

  const row = page.locator(`.setting-row:has(${TOGGLE})`);
  return { row, input: row.locator(TOGGLE), slider: row.locator(".toggle-slider") };
}

/** Escape clears the search filter first, then closes the dialog. */
async function closeSettings(page: Page) {
  const search = page.locator(".settings-search");
  for (let i = 0; i < 3 && (await search.isVisible()); i++) {
    await page.keyboard.press("Escape");
    await search.waitFor({ state: "hidden", timeout: 1000 }).catch(() => {});
  }
  await expect(search).toBeHidden();
}

test.describe("Preview pane auxiliary info (#494)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(PROJECT_URL);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForEntries(page);
  });

  test("shows metadata by default and hides it when the setting is off", async ({ page }) => {
    await openPreviewFor(page, "index.ts");

    // --- AC1: default state shows name, type badge, size and modified ---
    await expect(page.locator(".preview-pane .preview-filename")).toContainText("index.ts");
    await expect(page.locator(".preview-pane .preview-type-badge")).toBeVisible();
    const info = page.locator(".preview-pane .preview-info");
    await expect(info).toBeVisible();
    await expect(info).toContainText("Size");
    await expect(info).toContainText("Modified");
    await page.screenshot({ path: "evidence/ac-1-preview-info-shown.png" });

    // --- AC3: the setting exists in Settings and is on by default ---
    const setting = await openPreviewInfoSetting(page);
    await expect(setting.row).toBeVisible();
    await expect(setting.input).toBeChecked();
    await page.screenshot({ path: "evidence/ac-3-settings-toggle.png" });

    await setting.slider.click();
    await expect(setting.input).not.toBeChecked();
    await closeSettings(page);

    // --- AC2: metadata is gone, the previewed content is not ---
    await openPreviewFor(page, "index.ts");
    await expect(page.locator(".preview-pane .preview-code")).toBeVisible();
    await expect(page.locator(".preview-pane .preview-header")).toHaveCount(0);
    await expect(page.locator(".preview-pane .preview-filename")).toHaveCount(0);
    await expect(page.locator(".preview-pane .preview-type-badge")).toHaveCount(0);
    await expect(page.locator(".preview-pane .preview-info")).toHaveCount(0);
    await page.screenshot({ path: "evidence/ac-2-preview-info-hidden.png" });

    // --- AC3 (second half): turning it back on restores the metadata ---
    const again = await openPreviewInfoSetting(page);
    await again.slider.click();
    await expect(again.input).toBeChecked();
    await closeSettings(page);

    await openPreviewFor(page, "index.ts");
    await expect(page.locator(".preview-pane .preview-filename")).toContainText("index.ts");
    await expect(page.locator(".preview-pane .preview-info")).toContainText("Modified");
  });

  test("the hidden state survives a reload", async ({ page }) => {
    await openPreviewFor(page, "index.ts");
    const setting = await openPreviewInfoSetting(page);
    await setting.slider.click();
    await expect(setting.input).not.toBeChecked();
    await closeSettings(page);

    await page.reload();
    await waitForEntries(page);
    await openPreviewFor(page, "index.ts");

    await expect(page.locator(".preview-pane .preview-code")).toBeVisible();
    await expect(page.locator(".preview-pane .preview-info")).toHaveCount(0);
  });
});
