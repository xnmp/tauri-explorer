import fs from "node:fs";
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries, seedSettings } from "./helpers";

const proof = "screenshots/fix/758-separate-keyboard-shortcuts";
async function capture(page: import("@playwright/test").Page, name: string) {
  if (process.env.CAPTURE_758 !== "1") return;
  fs.mkdirSync(proof, { recursive: true });
  await page.locator(".modal-overlay").evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)));
  });
  await page.screenshot({ path: `${proof}/${name}.png` });
}
async function palette(page: import("@playwright/test").Page, query: string) {
  await page.keyboard.press("Control+Shift+p");
  const modal = page.locator(".command-palette-dialog");
  await expect(modal).toBeVisible();
  await modal.locator(".search-input").fill(query);
  return modal;
}
async function shortcuts(page: import("@playwright/test").Page) {
  const modal = await palette(page, "Keyboard Shortcuts");
  await modal.locator(".command-item").filter({ has: page.locator(".command-label", { hasText: /^Keyboard Shortcuts$/ }) }).click();
  await expect(page.locator(".keybindings-dialog")).toBeVisible();
  return page.locator(".keybindings-dialog");
}

test("general Settings and shortcut editor are separate and palette actions open each directly", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.keyboard.press("Control+,");
  const general = page.locator(".settings-dialog");
  await expect(general).toBeVisible();
  await expect(general.locator(".keybindings-settings")).toHaveCount(0);
  await expect(general.locator("select").first()).toBeVisible();
  await capture(page, "general-settings");
  await page.keyboard.press("Escape");
  await expect(general).toBeHidden();
  const commands = await palette(page, "Settings");
  await expect(commands.locator(".command-label", { hasText: /^Settings$/ })).toBeVisible();
  await capture(page, "settings-palette-action");
  await commands.locator(".command-item").filter({ has: page.locator(".command-label", { hasText: /^Settings$/ }) }).click();
  await expect(general).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(general).toBeHidden();
  const bindings = await shortcuts(page);
  await expect(bindings.locator(".setting-row")).toHaveCount(0);
  await expect(bindings.getByRole("button", { name: "Reset All" })).toBeVisible();
  await capture(page, "keyboard-shortcuts");
  await page.keyboard.press("Escape");
  await expect(bindings).toBeHidden();
  const list = await palette(page, "Keyboard Shortcuts");
  await capture(page, "shortcut-palette-action");
  await expect(list.locator(".command-label", { hasText: /^Keyboard Shortcuts$/ })).toBeVisible();
});

test("saved custom binding survives separate settings edits and still executes after reload", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("explorer-keybindings")) localStorage.setItem("explorer-keybindings", JSON.stringify({ "navigation.goUp": "Ctrl+Shift+Y" }));
  });
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  const bindings = await shortcuts(page);
  await bindings.locator(".search-input").fill("Up");
  const up = bindings.locator(".shortcut-row").filter({ has: page.locator(".shortcut-action", { hasText: /^Go Up$/ }) });
  await expect(up.locator(".shortcut-btn")).toContainText("Y");
  await capture(page, "persisted-custom-binding");
  await page.keyboard.press("Escape");
  await expect(bindings).toBeHidden();
  await page.keyboard.press("Control+,");
  const general = page.locator(".settings-dialog");
  await general.locator(".settings-search").fill("hidden");
  const hidden = general.locator(".setting-row").filter({ has: page.locator(".setting-label", { hasText: /^Show Hidden Files$/ }) });
  await hidden.locator("label.toggle").click();
  await expect(hidden.locator('input[type="checkbox"]')).toBeChecked();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(general).toBeHidden();
  await page.reload();
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+y");
  await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();
  const values = await page.evaluate(() => ({ bindings: JSON.parse(localStorage.getItem("explorer-keybindings") || "{}"), settings: JSON.parse(localStorage.getItem("explorer-settings") || "{}") }));
  expect(values.bindings["navigation.goUp"]).toBe("Ctrl+Shift+Y");
  expect(values.settings.showHidden).toBe(true);
});

test("dedicated editor stays keyboard accessible in a small window", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await seedSettings(page, { zoomLevel: 150 });
  await page.goto(HOME_URL);
  await waitForEntries(page);
  const bindings = await shortcuts(page);
  await expect(bindings.locator(".search-input")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(bindings.getByRole("button", { name: "Export" })).toBeFocused();
  const card = await bindings.boundingBox();
  expect(card!.x).toBeGreaterThanOrEqual(0);
  expect(card!.y).toBeGreaterThanOrEqual(0);
  expect(card!.x + card!.width).toBeLessThanOrEqual(640);
  expect(card!.y + card!.height).toBeLessThanOrEqual(480);
  await expect(bindings.getByRole("button", { name: "Close keyboard shortcuts" })).toBeInViewport();
  await capture(page, "small-window-keyboard-focus");
  await page.keyboard.press("Escape");
  await expect(bindings).toBeHidden();
  await page.keyboard.press("Control+,");
  const general = page.locator(".settings-dialog");
  await expect(general).toBeVisible();
  await expect(general.locator(".settings-search")).toBeFocused();
  await expect(general.getByRole("button", { name: "Close settings" })).toBeInViewport();
  const generalBounds = await general.boundingBox();
  expect(generalBounds!.x).toBeGreaterThanOrEqual(0);
  expect(generalBounds!.y).toBeGreaterThanOrEqual(0);
  expect(generalBounds!.x + generalBounds!.width).toBeLessThanOrEqual(640);
  expect(generalBounds!.y + generalBounds!.height).toBeLessThanOrEqual(480);
  await capture(page, "small-window-general-settings");
  await general.locator(".settings-search").fill("Keyboard Shortcuts");
  await general.getByRole("button", { name: "Open Keyboard Shortcuts" }).click();
  await expect(general).toBeHidden();
  await expect(bindings).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bindings).toBeHidden();
  await page.keyboard.press("Control+/");
  const reference = page.locator('[data-testid="shortcut-cheatsheet"]');
  await expect(reference).toBeVisible();
  await reference.getByRole("button", { name: "Edit Keyboard Shortcuts" }).click();
  await expect(reference).toBeHidden();
  await expect(bindings).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bindings).toBeHidden();
});

test("export, import and reset preserve the dedicated editor's binding contract", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  const bindings = await shortcuts(page);
  await bindings.locator(".search-input").fill("Go Up");
  const up = bindings.locator(".shortcut-row").filter({ has: page.locator(".shortcut-action", { hasText: /^Go Up$/ }) });
  await up.locator(".shortcut-btn").click();
  await page.keyboard.press("Control+Shift+y");
  await expect(up).toHaveClass(/customized/);
  const downloadPromise = page.waitForEvent("download");
  await bindings.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  const exported = fs.readFileSync((await download.path())!, "utf8");
  expect(JSON.parse(exported)["navigation.goUp"]).toBe("Ctrl+Shift+Y");
  await up.locator(".reset-btn").click();
  await expect(up).not.toHaveClass(/customized/);
  await bindings.locator('input[type="file"]').setInputFiles({ name: "keybindings.json", mimeType: "application/json", buffer: Buffer.from(exported) });
  await expect(bindings.locator(".import-status")).toContainText("Imported");
  await expect(up.locator(".shortcut-btn")).toContainText("Y");
  await bindings.getByRole("button", { name: "Reset All" }).click();
  await expect(up).not.toHaveClass(/customized/);
  await up.locator(".shortcut-btn").click();
  await page.keyboard.press("Escape");
  await expect(up).not.toHaveClass(/recording/);
  await expect(bindings).toBeVisible();
});
