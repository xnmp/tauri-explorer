import { test, expect } from "./fixtures";

test("a new explorer window opens with its address bar ready for typing", async ({ page }) => {
  await page.goto("/?path=/home/user&focusAddressBar=1");

  const input = page.locator(".path-input");
  await expect(input).toBeFocused();
  await input.pressSequentially("/");
  await expect(input).toHaveValue("/");
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
