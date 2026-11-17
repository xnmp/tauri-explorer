/**
 * E2E: window shortcuts from the focused address bar (#1730).
 *
 * A new window opens with its address bar focused. Bound Ctrl/Cmd chords must
 * run their command from there, while the field keeps text input and its
 * editing chords (Ctrl+A selects the field text, not every file).
 */
import { test, expect } from "./fixtures";

test("Ctrl+T from the focused address bar opens a new tab", async ({ page }) => {
  await page.goto("/?path=/home/user&focusAddressBar=1");
  const input = page.locator(".path-input");
  await expect(input).toBeFocused();
  await expect(page.locator(".entry-item:visible").first()).toBeVisible();
  await expect(page.locator(".tab")).toHaveCount(1);

  await page.keyboard.press("Control+t");

  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(page.locator(".tab").nth(1)).toHaveClass(/active/);
  await expect(page.locator('.entry-item[data-path="/home/user/Documents"]:visible')).toBeVisible();
  await page.screenshot({ path: "screenshots/fix/field-shortcuts/address-bar-ctrl-t.png", animations: "disabled" });
});

test("Ctrl+A in the address bar selects the field text, not the files", async ({ page }) => {
  await page.goto("/?path=/home/user&focusAddressBar=1");
  const input = page.locator(".path-input");
  await expect(input).toBeFocused();
  const entries = page.locator(".entry-item:visible");
  await expect(entries.first()).toBeVisible();
  const total = await entries.count();
  expect(total).toBeGreaterThan(2);
  const selectedBefore = await page.locator(".entry-item.selected:visible").count();
  // Collapse the field selection first so Ctrl+A has something to change.
  await page.keyboard.press("End");
  await expect.poll(() => input.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(await input.inputValue().then((v) => v.length));

  await page.keyboard.press("Control+a");

  await expect(input).toBeFocused();
  const value = await input.inputValue();
  expect(value.length).toBeGreaterThan(0);
  await expect.poll(() => input.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
    .toEqual([0, value.length]);
  await expect(page.locator(".entry-item.selected:visible")).toHaveCount(selectedBefore);
  await expect(page.locator(".tab")).toHaveCount(1);
});

test("typing in the focused address bar still types and navigates", async ({ page }) => {
  await page.goto("/?path=/home/user&focusAddressBar=1");
  const input = page.locator(".path-input");
  await expect(input).toBeFocused();
  await page.keyboard.press("Control+a");
  // Letters that are bound window shortcuts with Ctrl (t, n, w, p) type plainly.
  await input.pressSequentially("/home/user/Documents");
  await expect(input).toHaveValue("/home/user/Documents");
  await expect(page.locator(".tab")).toHaveCount(1);
  await input.press("Enter");
  await expect(page.locator(".status-path")).toHaveAttribute("title", "/home/user/Documents");
});
