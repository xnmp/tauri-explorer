import { test, expect } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("explorer-settings", JSON.stringify({ showPreviewPane: false })));
  await page.goto("/?path=/home/user");
  await page.locator('.entry-item[data-path="/home/user/notes.md"]').click();
});

test("Preview remains available from the palette's focused search input", async ({ page }, info) => {
  const palette = page.locator(".command-palette-dialog");
  for (const visible of [true, false]) {
    await page.keyboard.press("Control+Shift+p");
    const input = palette.locator(".search-input");
    await expect(input).toBeFocused();
    await input.fill("Toggle Preview Pane");
    const command = palette.locator(".command-item", { hasText: "Toggle Preview Pane" });
    await expect(command).toBeVisible();
    await command.click();
    await expect(palette).toBeHidden();
    if (visible) {
      await expect(page.locator(".preview-markdown")).toContainText("Some notes here");
      await page.screenshot({ path: info.outputPath("preview-palette-command.png") });
    } else await expect(page.locator(".preview-pane")).toBeHidden();
  }
});

test("Space belongs to path editing and toggles Preview after returning to files", async ({ page }) => {
  await page.keyboard.press("Control+l");
  const input = page.locator(".path-input");
  await expect(input).toBeFocused();
  await input.fill("/home/user/no-match");
  await input.press("End");
  await input.press("Space");
  await expect(input).toHaveValue("/home/user/no-match ");
  await expect(page.locator(".preview-pane")).toBeHidden();
  await input.press("Escape");
  await expect(input).toBeHidden();
  await page.locator('.entry-item[data-path="/home/user/notes.md"]').click();
  await page.keyboard.press("Space");
  await expect(page.locator(".preview-markdown")).toContainText("Some notes here");
  await page.keyboard.press("Space");
  await expect(page.locator(".preview-pane")).toBeHidden();
});
