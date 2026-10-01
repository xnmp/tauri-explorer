import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

for (const explicit of [false, true]) {
  test(`${explicit ? "Paste Image" : "Paste"} reports pending image work and displays its output`, async ({ page }) => {
    await page.goto("/?path=/home/user/Music&mockLatency=clipboard_paste_image:2000");
    await waitForEntries(page);
    await page.evaluate(() => localStorage.setItem("mock-report-clipboard-image", "1"));
    await pressShortcut(page, "v", { ctrlKey: true, shiftKey: explicit });
    const progress = page.getByRole("progressbar", { name: "Pasting clipboard image" });
    await expect(progress).toBeVisible({ timeout: 500 });
    await expect(progress).not.toHaveAttribute("aria-valuenow");
    await expect(progress.locator("..")).toContainText("/home/user/Music");
    await expect(page.locator('.entry-item[data-path="/home/user/Music/clipboard-image.png"]')).toHaveCount(0);
    await expect(page.locator('.entry-item[data-path="/home/user/Music/clipboard-image.png"]')).toBeVisible();
    await expect(progress).toHaveCount(0);
  });
}

test("navigation stays usable while a paste completes in its captured directory", async ({ page }) => {
  await page.goto("/?path=/home/user/Music&mockLatency=clipboard_paste_image:2000");
  await waitForEntries(page);
  await pressShortcut(page, "v", { ctrlKey: true, shiftKey: true });
  const progress = page.getByRole("progressbar", { name: "Pasting clipboard image" });
  await expect(progress).toBeVisible();
  await page.getByRole("button", { name: "Pictures", exact: true }).click();
  await expect(page.locator(".status-path")).toHaveAttribute("title", "/home/user/Pictures");
  await expect(progress).toBeVisible();
  await expect(progress).toHaveCount(0);
  await expect(page.locator(".status-path")).toHaveAttribute("title", "/home/user/Pictures");
  await expect(page.locator('.entry-item[data-path="/home/user/Pictures/clipboard-image.png"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Music", exact: true }).click();
  await expect(page.locator('.entry-item[data-path="/home/user/Music/clipboard-image.png"]')).toBeVisible();
});

for (const command of ["clipboard_has_image", "clipboard_paste_image"]) {
  test(`${command} failure ends pending feedback and exposes its reason`, async ({ page }) => {
    await page.addInitScript((name) => {
      (globalThis as { __mockControl?: unknown }).__mockControl = { failures: { [name]: "clipboard test permission denied" } };
    }, command);
    await page.goto(`/?path=/home/user/Music&mockLatency=${command}:1000`);
    await waitForEntries(page);
    await pressShortcut(page, "v", { ctrlKey: true, shiftKey: command === "clipboard_paste_image" });
    const progress = page.getByRole("progressbar", { name: "Pasting clipboard image" });
    await expect(progress).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("clipboard test permission denied");
    await expect(progress).toHaveCount(0);
    await expect(page.locator('.entry-item[data-path="/home/user/Music/clipboard-image.png"]')).toHaveCount(0);
    await expect(page.locator(".status-path")).toHaveAttribute("title", "/home/user/Music");
  });
}
