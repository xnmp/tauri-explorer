import { test, expect } from "./fixtures";
import { focusBeforeFileList, VIEW_MODES } from "./helpers";

for (const mode of VIEW_MODES) {
  for (const action of ["open", "switch by click", "switch by shortcut"] as const) {
    test(`${mode}: ${action} tab keeps keyboard browsing after new-window address selection`, async ({ page }) => {
      await page.goto(`/?path=/home/user&focusAddressBar=1&viewMode=${mode}`);
      await expect(page.locator(".path-input")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.locator(".path-input")).toHaveCount(0);

      await page.keyboard.press("Control+t");
      await expect(page.locator(".tab")).toHaveCount(2);
      if (action === "switch by click") await page.locator(".tab").first().click();
      if (action === "switch by shortcut") await page.keyboard.press("Control+Shift+Tab");
      await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();

      await expect(page.locator(".path-input")).toHaveCount(0);
      await focusBeforeFileList(page);
      await page.keyboard.press("Tab");
      await expect(page.locator(".file-list .entry-item:focus")).toHaveCount(1);
      await page.keyboard.type("Doc");
      await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toHaveClass(/selected/);
      await expect(page.locator(".path-input")).toHaveCount(0);
      if (process.env.CAPTURE_TAB_FOCUS && mode === "details" && action === "switch by shortcut") {
        await page.screenshot({ path: "screenshots/fix/tab-address-focus/keyboard-browsing.png" });
      }
      await page.keyboard.press("Enter");
      await expect(page.locator(".status-path")).toHaveAttribute("title", "/home/user/Documents");
      await expect(page.locator('.entry-item[data-path="/home/user/Documents/project"]')).toBeVisible();
      await page.keyboard.press("Control+l");
      await expect(page.locator(".path-input")).toBeFocused();
      await expect(page.locator(".path-input")).toHaveValue("/home/user/Documents");
    });
  }
}

test("a new explorer window opens with its address bar ready for typing", async ({ page }) => {
  await page.goto("/?path=/home/user&focusAddressBar=1");

  const input = page.locator(".path-input");
  await expect(input).toBeFocused();
  await input.pressSequentially("/");
  await expect(input).toHaveValue("/");
});

test("new-window address selection survives a settings remount during initial navigation", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("explorer-settings", JSON.stringify({ previewPanePosition: "right" }));
    localStorage.setItem("mock-config-files", JSON.stringify({
      "settings.json": JSON.stringify({ previewPanePosition: "bottom" }),
    }));
  });
  await page.goto("/?path=/home/user/Documents&focusAddressBar=1&mockLatency=read_config_file:500,list_directory:2000,list_directory_fresh:2000");
  await expect(page.locator(".pane-preview-stack")).toBeVisible();
  const input = page.locator(".path-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("/home/user/Documents");
  await input.pressSequentially("/home/user/Pictures");
  await expect(input).toHaveValue("/home/user/Pictures");
  await input.press("Enter");
  await expect(page.locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]')).toBeVisible();
});

test("opening a tab during slow window startup cancels pending address selection", async ({ page }) => {
  await page.goto("/?path=/home/user&focusAddressBar=1&mockLatency=list_directory:2000,list_directory_fresh:2000", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".tab")).toHaveCount(1);
  await page.keyboard.press("Control+t");
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(".entry-item").first()).toBeVisible();
  await expect(page.locator(".path-input")).toHaveCount(0);
  await page.keyboard.press("Control+l");
  await expect(page.locator(".path-input")).toBeFocused();
});

test("delayed initial navigation selects the requested path once and preserves subsequent typing", async ({ page }) => {
  const initial = "/home/user/Documents";
  const replacement = "/home/user/Pictures";
  const start = new Date("2026-10-01T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  await page.goto("/?path=/home/user/Documents&focusAddressBar=1&mockLatency=list_directory_fresh:2000,list_directory:2000", { waitUntil: "domcontentloaded" });
  await expect.poll(async () => {
    await page.clock.runFor(50);
    return page.evaluate(() => {
      const counts = (globalThis as { __mockControl?: { invokeCounts?: Record<string, number> } }).__mockControl?.invokeCounts;
      return (counts?.list_directory_fresh ?? 0) + (counts?.list_directory ?? 0);
    });
  }).toBeGreaterThan(0);
  const input = page.locator(".path-input");
  await expect(input).toHaveCount(0);

  await page.clock.runFor(2500);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(initial);
  expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, initial.length]);

  await input.pressSequentially(replacement);
  await page.clock.runFor(5000);
  await expect(input).toHaveValue(replacement);
  await expect(input).toBeFocused();
  expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([replacement.length, replacement.length]);
  await input.press("Enter");
  await expect.poll(async () => {
    await page.clock.runFor(500);
    return page.locator(".status-path").getAttribute("title");
  }).toBe(replacement);
  await expect(page.locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]')).toBeVisible();
});
