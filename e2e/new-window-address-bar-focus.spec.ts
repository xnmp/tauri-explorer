import { test, expect } from "./fixtures";

test("a new explorer window opens with its address bar ready for typing", async ({ page }) => {
  await page.goto("/?path=/home/user&focusAddressBar=1");

  const input = page.locator(".path-input");
  await expect(input).toBeFocused();
  await input.pressSequentially("/");
  await expect(input).toHaveValue("/");
});
