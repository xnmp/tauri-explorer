/**
 * E2E: SDK-2 plugin file views, Preview targets and Preview-info sections,
 * exercised through the built-in demo plugin's "Demo Cards" view.
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, pressShortcut, runPaletteCommand, switchViewMode, waitForEntries } from "./helpers";

async function setDemoPluginEnabled(page: Page, enabled: boolean) {
  await page.keyboard.press("Control+,");
  await expect(page.locator(".settings-dialog")).toBeVisible({ timeout: 2000 });
  await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
  const dialog = page.locator(".plugins-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  const row = dialog.locator('.setting-row:has-text("Demo Plugin")').first();
  const toggle = row.locator('input[type="checkbox"]').first();
  if ((await toggle.isChecked()) !== enabled) await row.locator("label.toggle").click();
  await expect(toggle).toBeChecked({ checked: enabled });
  await page.locator(".plugins-dialog .close-btn").click();
  await expect(dialog).toBeHidden();
}

/** Chooses the demo view from the background context menu's view options. */
async function chooseDemoView(page: Page) {
  await page.keyboard.press("Escape");
  const content = page.locator(".file-list .content").first();
  const box = await content.boundingBox();
  const last = await page.locator(".entry-item").last().boundingBox();
  const y = box && last ? Math.min(Math.round(last.y + last.height - box.y) + 12, Math.round(box.height) - 8) : 300;
  await content.click({ button: "right", position: { x: 10, y } });
  const menu = page.locator(".context-menu");
  await menu.waitFor({ state: "visible", timeout: 2000 });
  await menu.getByRole("menuitemradio", { name: "Demo Cards" }).click();
  await expect(page.getByTestId("demo-file-view")).toBeVisible();
}

async function openPreview(page: Page) {
  const pane = page.locator(".preview-pane");
  if (!(await pane.isVisible())) {
    await pressShortcut(page, " ", {});
    await expect(pane).toBeVisible();
  }
  return pane;
}

test.describe("Plugin file views (demo plugin)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
  });

  test("a contributed view replaces the listing and acts on this pane's selection", async ({ page }) => {
    await setDemoPluginEnabled(page, true);
    await chooseDemoView(page);
    await expect(page.locator(".entry-item")).toHaveCount(0);

    const preview = await openPreview(page);
    const card = page.getByTestId("demo-file-view").locator('.card[data-path="/home/user/readme.txt"]');
    await card.click();
    await expect(card).toHaveClass(/selected/);
    await expect(preview.getByTestId("demo-preview-info")).toHaveText("Demo info: readme.txt");

    await card.click({ button: "right" });
    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator('.menu-item:has-text("Demo: Greet Selection")')).toBeVisible();
  });

  test("Preview targets show plugin subjects with explicit actions, not as files", async ({ page }) => {
    await setDemoPluginEnabled(page, true);
    await chooseDemoView(page);
    const preview = await openPreview(page);
    const view = page.getByTestId("demo-file-view");

    await view.locator('.card[data-path="/home/user/readme.txt"]').click();
    await view.getByRole("button", { name: "Virtual card" }).click();

    await expect(preview).toContainText("Virtual card");
    await expect(preview).toContainText("Unsaved");
    await expect(preview.getByTestId("demo-preview-info")).toHaveText("Demo info: Virtual card");
    // Showing a target clears the file selection; nothing in Preview is a draggable path.
    await expect(view.locator(".card.selected[data-path]")).toHaveCount(0);
    await expect(preview.locator('[draggable="true"]')).toHaveCount(0);

    await preview.getByRole("button", { name: "Greet" }).click();
    await expect(page.locator(".toast").filter({ hasText: "Greetings from the virtual card" })).toBeVisible();

    // Selecting a real file replaces the target.
    await view.locator('.card[data-path="/home/user/readme.txt"]').click();
    await expect(preview.getByTestId("demo-preview-info")).toHaveText("Demo info: readme.txt");
    await expect(preview).not.toContainText("Virtual card");
  });

  test("the toggle command returns to the previous built-in view", async ({ page }) => {
    await switchViewMode(page, "tiles");
    await setDemoPluginEnabled(page, true);

    await runPaletteCommand(page, "Demo: Toggle Cards View");
    await expect(page.getByTestId("demo-file-view")).toBeVisible();
    await expect(page.locator(".tiles-view")).toHaveCount(0);

    await runPaletteCommand(page, "Demo: Toggle Cards View");
    await expect(page.getByTestId("demo-file-view")).toHaveCount(0);
    await expect(page.locator(".tiles-view")).toBeVisible();
  });

  test("folders a view cannot show fall back to the built-in view and keep the preference", async ({ page }) => {
    await setDemoPluginEnabled(page, true);
    await chooseDemoView(page);

    await runPaletteCommand(page, "Demo: Open Virtual Folder");
    await expect(page.locator(".entry-item").filter({ hasText: "hello.txt" }).first()).toBeVisible({ timeout: 3000 });
    await expect(page.getByTestId("demo-file-view")).toHaveCount(0);

    await runPaletteCommand(page, "Go Back");
    await expect(page.getByTestId("demo-file-view")).toBeVisible({ timeout: 3000 });
  });

  test("drops onto a plugin view never move files, and inline rename is unavailable there", async ({ page }) => {
    await setDemoPluginEnabled(page, true);
    await chooseDemoView(page);
    const view = page.getByTestId("demo-file-view");
    const before = await view.locator(".card[data-path]").count();
    await view.evaluate((element) => {
      const data = new DataTransfer();
      data.setData("text/uri-list", "file:///home/user/Documents/project");
      data.setData("text/plain", "/home/user/Documents/project");
      for (const type of ["dragenter", "dragover", "drop"]) {
        element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      }
    });
    await page.waitForTimeout(300);
    await expect(view.locator(".card[data-path]")).toHaveCount(before);
    await expect(view.locator('.card[data-path="/home/user/project"]')).toHaveCount(0);

    const card = view.locator('.card[data-path="/home/user/readme.txt"]');
    await card.click();
    await card.click({ button: "right" });
    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Rename/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await pressShortcut(page, "F2", {});
    // No invisible rename state: global shortcuts still work.
    await runPaletteCommand(page, "Demo: Hello");
    await expect(page.locator(".toast").filter({ hasText: "Hello from the demo plugin" })).toBeVisible();
  });

  test("disabling the plugin restores the built-in view and clears its Preview target", async ({ page }) => {
    await setDemoPluginEnabled(page, true);
    await chooseDemoView(page);
    const preview = await openPreview(page);
    await page.getByTestId("demo-file-view").getByRole("button", { name: "Virtual card" }).click();
    await expect(preview).toContainText("Virtual card");

    await setDemoPluginEnabled(page, false);
    await expect(page.getByTestId("demo-file-view")).toHaveCount(0);
    await expect(page.locator(".entry-item").first()).toBeVisible();
    await expect(preview).not.toContainText("Virtual card");
    await expect(page.getByTestId("demo-preview-info")).toHaveCount(0);
  });
});
