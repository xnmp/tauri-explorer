/**
 * E2E: SDK-2 plugin file views, Preview targets and Preview-info sections,
 * exercised through the built-in demo plugin's "Demo Cards" view.
 */
import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, HOME_URL, pressShortcut, runPaletteCommand, switchViewMode, waitForEntries } from "./helpers";

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

/** Changes the global tile size from the Settings dialog. */
async function setGlobalTileSize(page: Page, size: "small" | "medium" | "large" | "xlarge") {
  await page.keyboard.press("Control+,");
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  const row = dialog.locator(".setting-row").filter({ has: page.locator(".setting-label", { hasText: /^Thumbnail Size$/ }) });
  await row.scrollIntoViewIfNeeded();
  await row.locator("select").selectOption(size);
  await dialog.locator(".close-btn").click();
  await expect(dialog).toBeHidden();
}

/** Sets this folder's tile size through "Tile View: Set Size". */
async function setFolderTileSize(page: Page, label: string) {
  await runPaletteCommand(page, "Tile View: Set Size");
  const picker = page.locator(".option-picker-dialog");
  await expect(picker).toBeVisible({ timeout: 2000 });
  await picker.locator(".option-picker-item").filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).click();
  await expect(picker).toBeHidden();
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

  test("the view reads its folder's tile size, live, and Set Size keeps it shown", async ({ page }) => {
    await applySettingsAndReload(page, { thumbnailSize: "medium" });
    await waitForEntries(page);
    await setDemoPluginEnabled(page, true);
    await chooseDemoView(page);
    const view = page.getByTestId("demo-file-view");
    const size = view.getByTestId("demo-tile-size");
    // Its "Demo tiles" pass no `size`: they follow the view's folder too.
    const tileIcon = view.getByRole("grid", { name: "Demo tiles" }).locator(".tile-icon").first();
    const expectSize = async (preset: string, px: number) => {
      await expect(size).toHaveAttribute("data-preset", preset);
      await expect(size).toHaveAttribute("data-image-px", String(px));
      await expect.poll(() => tileIcon.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(px);
    };
    await expectSize("medium", 64);
    // Tag the mounted view: every later check must see this same instance.
    await view.evaluate((element) => { (element as HTMLElement & { __mountTag?: string }).__mountTag = "first"; });
    const sameMount = () => view.evaluate((element) => (element as HTMLElement & { __mountTag?: string }).__mountTag);

    await setGlobalTileSize(page, "large");
    await expectSize("large", 96);

    await setFolderTileSize(page, "Extra Large");
    await expectSize("xlarge", 128);
    // The plugin view stays, sized by the folder's new override.
    await expect(page.locator(".tiles-view")).toHaveCount(0);
    expect(await sameMount()).toBe("first");

    // The folder's override wins over a later global change...
    await setGlobalTileSize(page, "small");
    await expectSize("xlarge", 128);
    expect(await sameMount()).toBe("first");

    // ...and applies to this folder only.
    await view.locator('.card[data-path="/home/user/Documents"]').dblclick();
    await expect(view.locator('.card[data-path="/home/user/Documents/project"]')).toBeVisible();
    await expectSize("small", 48);
    await runPaletteCommand(page, "Go Back");
    await expect(view.locator('.card[data-path="/home/user/Documents"]')).toBeVisible();
    await expectSize("xlarge", 128);
  });

  test("Set Size from a built-in view still switches to Tiles", async ({ page }) => {
    await setDemoPluginEnabled(page, true);
    await setFolderTileSize(page, "Large");
    await expect(page.locator(".tiles-view")).toBeVisible();
    await expect(page.getByTestId("demo-file-view")).toHaveCount(0);
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
