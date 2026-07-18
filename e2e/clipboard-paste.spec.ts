/**
 * E2E: clipboard → file creation commands (#296).
 *
 *  - "Paste Clipboard as Text File" (edit.pasteAsTextFile): reads the browser
 *    text clipboard via navigator.clipboard.readText() and writes a
 *    `pasted-<timestamp>.txt` file with that content.
 *  - "Paste Image from Clipboard" (edit.pasteImage, Ctrl+Shift+V): asks the
 *    backend to materialise the clipboard image; the mock writes
 *    `clipboard-image.png` into the current directory.
 *
 * Both are driven through the real command surface (palette / shortcut) and
 * assert the actual new file entry that results.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

async function runPaletteCommand(page: Page, label: string) {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.waitFor({ state: "visible", timeout: 2000 });
  await palette.locator(".search-input").fill(label);
  const cmd = palette.locator(`.command-item:has-text("${label}")`).first();
  await expect(cmd).toBeVisible();
  await cmd.click();
  await expect(palette).toBeHidden();
}

test.describe("Paste clipboard as text file", () => {
  test("creates a pasted-*.txt file containing the clipboard text", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName === "webkit", "WebKit does not support Playwright clipboard permissions");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await page.goto("/?path=/home/user/Music");
    await waitForEntries(page);

    const clipboardText = "hello from the clipboard 12345";
    await page.evaluate((t) => navigator.clipboard.writeText(t), clipboardText);

    await runPaletteCommand(page, "Paste Clipboard as Text File");

    // A new pasted-*.txt entry appears.
    const pasted = page.locator(".entry-item .entry-name", { hasText: /^pasted-.*\.txt$/ });
    await expect(pasted).toHaveCount(1, { timeout: 5000 });

    // Its content is the clipboard text (verified via the text preview pane).
    await pasted.first().click();
    const previewPane = page.locator(".preview-pane");
    if (!(await previewPane.isVisible())) {
      await pressShortcut(page, " ", {});
    }
    await expect(previewPane).toBeVisible();
    await expect(page.locator(".preview-text")).toContainText(clipboardText, {
      timeout: 5000,
    });
  });
});

test.describe("Paste image from clipboard", () => {
  test("Ctrl+Shift+V creates clipboard-image.png in the current folder", async ({
    page,
  }) => {
    await page.goto("/?path=/home/user/Music");
    await waitForEntries(page);

    await expect(
      page.locator(".entry-item .entry-name", { hasText: "clipboard-image.png" }),
    ).toHaveCount(0);

    await pressShortcut(page, "v", { ctrlKey: true, shiftKey: true });

    await expect
      .poll(() => page.locator(".entry-item .entry-name").allTextContents(), {
        timeout: 5000,
      })
      .toContain("clipboard-image.png");
  });
});
