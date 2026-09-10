import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test("custom theme controls remain keyboard-operable in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 640 });
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `
        [data-theme="keyboard-custom"] {
          --theme-name: "Keyboard Custom";
          --theme-description: "Interaction test";
          --background-solid: #17141f;
          --divider: #312943;
          --text-primary: #f7efff;
          --text-secondary: #d7c8e8;
          --text-tertiary: #aa96bf;
          --text-on-accent: #160f1d;
          --accent: #e4a8ff;
          --surface-stroke: #57466b;
        }
      `;
      document.head.appendChild(style);
    });
  });
  await page.goto(HOME_URL);
  await waitForEntries(page);

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Switch Theme");
  await page.keyboard.press("Enter");

  const dialog = page.locator(".theme-picker-dialog");
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(480);

  const search = dialog.locator(".search-input");
  await expect(search).toBeFocused();
  await search.fill("Keyboard Custom");
  await page.keyboard.press("ArrowDown");

  const selected = dialog.locator(".theme-item.selected");
  await expect(selected).toContainText("Keyboard Custom");
  const colors = await selected.evaluate((element) => {
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    return {
      background: style.backgroundColor,
      foreground: style.color,
      accent: root.getPropertyValue("--accent").trim(),
      onAccent: root.getPropertyValue("--text-on-accent").trim(),
    };
  });
  expect(colors.background).toBe("rgb(228, 168, 255)");
  expect(colors.foreground).toBe("rgb(22, 15, 29)");
  expect(colors.accent).toBe("#e4a8ff");
  expect(colors.onAccent).toBe("#160f1d");

  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "keyboard-custom");
});
