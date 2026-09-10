import { test, expect } from "./fixtures";
import { VIEW_MODES, switchViewMode } from "./helpers";

for (const mode of VIEW_MODES) {
  test.describe(`File entry commands [${mode}]`, () => {

    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("explorer-settings", JSON.stringify({ showPreviewPane: false })));
      await page.goto("/?path=/home/user");
      await switchViewMode(page, mode);
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


    test("Enter opens a focused directory entry", async ({ page }) => {
      const directory = page.locator('.entry-item[data-path="/home/user/Documents"]');
      await directory.click();
      await expect(directory).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator(".status-path")).toHaveAttribute("title", "/home/user/Documents");
      await expect(page.locator('.entry-item[data-path="/home/user/Documents/report.pdf"]')).toBeVisible();
    });
    for (const key of ["Enter", "Space"]) {
      test(`Miller folder ${key} navigates independently of the selected file`, async ({ page }) => {
        await page.locator('.file-list .entry-item[data-path="/home/user/Documents"]').dblclick();
        await page.locator('.file-list .entry-item[data-path="/home/user/Documents/report.pdf"]').click();
        await page.keyboard.press("Control+Shift+p");
        const palette = page.locator(".command-palette-dialog");
        await palette.locator(".search-input").fill("Miller Columns: 1 Layer");
        await palette.locator(".command-item", { hasText: "Miller Columns: 1 Layer" }).click();
        await expect(palette).toBeHidden();
        const folder = page.locator('.miller-columns .col-entry[data-path="/home/user/Downloads"]');
        await folder.focus();
        await page.keyboard.press(key);
        await expect(page.locator(".status-path")).toHaveAttribute("title", "/home/user/Downloads");
        await expect(page.locator('.file-list .entry-item[data-path="/home/user/Downloads/archive.zip"]')).toBeVisible();
        await expect(page.locator(".preview-pane")).toBeHidden();
      });
    }
    test("spaces in filename type-ahead preserve selection without opening Preview", async ({ page }) => {
      for (const [source, name] of [["readme.txt", "annual draft.txt"], ["notes.md", "annual report.md"]]) {
        await page.locator(`.file-list .entry-item[data-path="/home/user/${source}"]`).click();
        await page.keyboard.press("F2");
        const rename = page.locator(".rename-input");
        await rename.fill(name);
        await rename.press("Enter");
        await expect(rename).toBeHidden();
        await expect(page.locator(`.file-list .entry-item[data-path="/home/user/${name}"]`)).toBeVisible();
      }
      await page.locator('.file-list .entry-item[data-path="/home/user/annual draft.txt"]').click();
      await page.keyboard.type("annual r");
      await expect(page.locator('.file-list .entry-item[data-path="/home/user/annual report.md"]')).toHaveClass(/selected/);
      await expect(page.locator(".preview-pane")).toBeHidden();
    });
  });
}
