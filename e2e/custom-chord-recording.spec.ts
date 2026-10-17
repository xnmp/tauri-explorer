import fs from "node:fs";
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

const proof = "screenshots/fix/759-enable-chords-in-custom-keybindings";
async function capture(page: import("@playwright/test").Page, name: string) {
  if (process.env.CAPTURE_759 !== "1") return;
  fs.mkdirSync(proof, { recursive: true });
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path: `${proof}/${name}.png` });
}
async function openEditor(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator(".search-input").fill("Keyboard Shortcuts");
  await palette.locator(".command-item").filter({ has: page.locator(".command-label", { hasText: /^Keyboard Shortcuts$/ }) }).click();
  const editor = page.locator(".keybindings-dialog");
  await expect(editor).toBeVisible();
  return editor;
}
const row = (page: import("@playwright/test").Page, label: string) => page.locator(".shortcut-row").filter({ has: page.locator(".shortcut-action", { hasText: label, exact: true }) });

test("recording two steps preserves the prefix then saves a chord that executes after reload", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  const editor = await openEditor(page);
  await editor.locator(".search-input").fill("Go Up");
  const up = row(page, "Go Up");
  await up.getByRole("button", { name: "Record chord" }).click();
  await page.keyboard.press("Alt+m");
  await expect(up.locator(".recording-text")).toContainText("second key");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("explorer-keybindings") || "{}")["navigation.goUp"])).toBeUndefined();
  await capture(page, "recording-step-two");
  await page.keyboard.press("m");
  await expect(up.locator(".shortcut-btn")).toContainText("then");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("explorer-keybindings") || "{}")["navigation.goUp"])).toBe("Alt+M M");
  await capture(page, "saved-alt-m-m");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.reload();
  await waitForEntries(page);
  await page.keyboard.press("Control+l");
  const address = page.locator(".path-input");
  await address.fill("typed");
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("m");
  await expect(address).toHaveValue("typedm");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+m");
  await expect(page.locator('.entry-item[data-path="/home/user/Documents/report.pdf"]')).toBeVisible();
  await page.keyboard.press("m");
  await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();
  await capture(page, "chord-command-navigated-parent");
});

test("duplicate chord override survives restart and round-trips explicit unbindings", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  const editor = await openEditor(page);
  await editor.locator(".search-input").fill("Go Up");
  const up = row(page, "Go Up");
  await up.getByRole("button", { name: "Record chord" }).click();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("b");
  await expect(up.locator(".conflict-warning")).toContainText("Toggle Files Sidebar");
  await up.locator(".override-btn").click();
  const downloadPromise = page.waitForEvent("download");
  await editor.getByRole("button", { name: "Export", exact: true }).click();
  const exported = fs.readFileSync((await (await downloadPromise).path())!, "utf8");
  expect(JSON.parse(exported)["view.focusFilesSidebar"]).toBeNull();
  await editor.getByRole("button", { name: "Reset All" }).click();
  await editor.locator('input[type="file"]').setInputFiles({ name: "chords.json", mimeType: "application/json", buffer: Buffer.from(exported) });
  await expect(up.locator(".shortcut-btn")).toContainText("then");
  await expect(editor.locator(".import-status")).not.toContainText("conflicting");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.reload();
  await waitForEntries(page);
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("b");
  await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();
  await expect(page.locator(".sidebar")).toBeVisible();
  const reopened = await openEditor(page);
  await reopened.locator(".search-input").fill("Go Up");
  await row(page, "Go Up").locator(".reset-btn").click();
  await expect(row(page, "Go Up").locator(".shortcut-btn")).not.toContainText("then");
});

test("recorder cancel and prefix ambiguity are explicit without changing bindings", async ({ page }) => {
  await page.goto("/?path=/home/user");
  await waitForEntries(page);
  const editor = await openEditor(page);
  await editor.locator(".search-input").fill("Go Up");
  const up = row(page, "Go Up");
  await up.getByRole("button", { name: "Record chord" }).click();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("Escape");
  await expect(up).not.toHaveClass(/recording/);
  await expect(up.locator(".shortcut-btn")).not.toContainText("then");
  await up.locator(".shortcut-btn").click();
  await page.keyboard.press("Alt+m");
  await expect(up.locator(".conflict-warning")).toContainText("Conflicts with");
  const bounds = await up.evaluate((element) => {
    const outer = element.getBoundingClientRect();
    return [...element.querySelectorAll(".shortcut-action, .cancel-btn, .conflict-warning, .override-btn")].every((child) => {
      const rect = child.getBoundingClientRect();
      return rect.width > 0 && rect.left >= outer.left && rect.right <= outer.right + 1;
    });
  });
  expect(bounds).toBe(true);
  await capture(page, "ambiguous-prefix-conflict");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("b");
  await expect(page.locator(".sidebar")).toBeHidden();
});


test("modified suffix uses actual modifier events and chord labels reach help and palette", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  const editor = await openEditor(page);
  await editor.locator(".search-input").fill("Go Up");
  const up = row(page, "Go Up");
  await up.getByRole("button", { name: "Record chord" }).click();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("Control+c");
  await expect(up.locator(".shortcut-btn")).toContainText("then");
  await expect(up.locator(".shortcut-btn")).toContainText("Ctrl");
  await capture(page, "modified-suffix-saved");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator(".search-input").fill("Go Up");
  await expect(palette.locator(".command-item").filter({ has: page.locator(".command-label", { hasText: /^Go Up$/ }) }).locator(".command-shortcut")).toHaveAttribute("aria-label", "Alt+M Ctrl+C");
  await capture(page, "chord-in-command-palette");
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await page.keyboard.press("Control+/");
  const help = page.getByTestId("shortcut-cheatsheet");
  await expect(help).toBeVisible();
  await expect(help.locator("kbd", { hasText: "Alt+M Ctrl+C" })).toBeVisible();
  await help.locator("kbd", { hasText: "Alt+M Ctrl+C" }).scrollIntoViewIfNeeded();
  await expect(help.locator("kbd", { hasText: "Alt+M Ctrl+C" })).toBeInViewport();
  await capture(page, "chord-in-shortcut-reference");
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("Control+c");
  await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();
  await capture(page, "modified-suffix-navigated-parent");
});

test("exported binding swaps import after Reset All without intermediate conflicts", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  const editor = await openEditor(page);
  await editor.locator(".search-input").fill("Go Up");
  await row(page, "Go Up").getByRole("button", { name: "Record chord" }).click();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("b");
  await row(page, "Go Up").locator(".override-btn").click();
  await editor.locator(".search-input").fill("Toggle Files Sidebar");
  await row(page, "Toggle Files Sidebar").locator(".shortcut-btn").click();
  await page.keyboard.press("Control+Alt+ArrowUp");
  const downloading = page.waitForEvent("download");
  await editor.getByRole("button", { name: "Export", exact: true }).click();
  const exported = fs.readFileSync((await (await downloading).path())!, "utf8");
  expect(JSON.parse(exported)).toMatchObject({ "navigation.goUp": "Alt+M B", "view.focusFilesSidebar": "Ctrl+Alt+Up" });
  await editor.getByRole("button", { name: "Reset All" }).click();
  await editor.locator('input[type="file"]').setInputFiles({ name: "swap.json", mimeType: "application/json", buffer: Buffer.from(exported) });
  await expect(editor.locator(".import-status")).toHaveText("Imported 2 shortcuts");
  await capture(page, "valid-swap-imported");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.reload();
  await waitForEntries(page);
  await page.keyboard.press("Control+Alt+ArrowUp");
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator('.entry-item[data-path="/home/user/Documents/report.pdf"]')).toBeVisible();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("b");
  await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();
});

test("recorder timeout, outside focus, and window blur retire unfinished edits", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  const editor = await openEditor(page);
  await editor.locator(".search-input").fill("Go Up");
  const up = row(page, "Go Up");
  await up.getByRole("button", { name: "Record chord" }).click();
  await page.keyboard.press("Alt+m");
  await expect(editor.getByRole("status", { name: "" }).filter({ hasText: "timed out" })).toBeVisible();
  await expect(up).not.toHaveClass(/recording/);
  await up.getByRole("button", { name: "Record chord" }).click();
  await page.keyboard.press("Alt+m");
  await editor.locator(".search-input").click();
  await expect(up).not.toHaveClass(/recording/);
  await up.getByRole("button", { name: "Record chord" }).click();
  await page.keyboard.press("Alt+m");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(up).not.toHaveClass(/recording/);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("explorer-keybindings") || "{}"))).toEqual({});
});


test("WebKitGTK Super-only events keep recording alive and retain the tracked modifier", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  const editor = await openEditor(page);
  await editor.locator(".search-input").fill("Go Up");
  const up = row(page, "Go Up");
  await up.getByRole("button", { name: "Record chord" }).click();
  await page.keyboard.press("Alt+m");
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Super", bubbles: true, cancelable: true })));
  await expect(up.locator(".recording-text")).toContainText("second key");
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", metaKey: false, bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Super", bubbles: true }));
  });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("explorer-keybindings") || "{}")["navigation.goUp"])).toBe("Alt+M Ctrl+C");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("Control+c");
  await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();
});


for (const [shortcut, prefix, suffix] of [["Ctrl+J M", "Control+j", "m"], ["Alt+M Ctrl+J", "Alt+m", "Control+j"]]) {
  test(`configured ${shortcut} navigates instead of opening Jobs`, async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    const editor = await openEditor(page);
    await editor.locator(".search-input").fill("Go Up");
    const up = row(page, "Go Up");
    await up.getByRole("button", { name: "Record chord" }).click();
    await page.keyboard.press(prefix);
    await page.keyboard.press(suffix);
    if (shortcut === "Ctrl+J M") {
      await expect(up.locator(".conflict-warning")).toContainText("Jobs Panel");
      await capture(page, "window-shortcut-prefix-warning");
      await up.locator(".cancel-btn").click();
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("explorer-keybindings") || "{}")["navigation.goUp"])).toBeUndefined();
      await up.getByRole("button", { name: "Record chord" }).click();
      await page.keyboard.press(prefix);
      await page.keyboard.press(suffix);
      await up.locator(".override-btn").click();
      const downloading = page.waitForEvent("download");
      await editor.getByRole("button", { name: "Export", exact: true }).click();
      const exported = fs.readFileSync((await (await downloading).path())!, "utf8");
      expect(Object.keys(JSON.parse(exported))).toEqual(["navigation.goUp"]);
      await editor.getByRole("button", { name: "Reset All" }).click();
      await editor.locator('input[type="file"]').setInputFiles({ name: "window-chord.json", mimeType: "application/json", buffer: Buffer.from(exported) });
      await expect(editor.locator(".import-status")).toHaveText("Imported 1 shortcuts; overrides window shortcuts: Jobs Panel");
    }
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("explorer-keybindings") || "{}")["navigation.goUp"])).toBe(shortcut);
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await page.keyboard.press(prefix);
    await page.keyboard.press(suffix);
    await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();
    await expect(page.locator(".jobs-panel")).toBeHidden();
  });
}

for (const [shortcut, prefix, suffix] of [["Ctrl+V M", "Control+v", "m"], ["Alt+M Ctrl+V", "Alt+m", "Control+v"], ["Alt+ArrowLeft M", "Alt+ArrowLeft", "m"]]) {
  test(`terminal-focused ${shortcut} executes the configured toggle`, async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel.locator(".xterm")).toBeVisible();
    const editor = await openEditor(page);
    await editor.locator('input[type="file"]').setInputFiles({ name: "terminal-chord.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ "general.openTerminal": shortcut, "edit.paste": null })) });
    await expect(editor.locator(".import-status")).not.toContainText("conflicting");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("explorer-keybindings") || "{}")["general.openTerminal"])).toBe(shortcut);
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    await panel.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.press(prefix);
    await expect(panel).toBeVisible();
    await page.keyboard.press(suffix);
    await expect(panel).toBeHidden();
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/report.pdf"]')).toBeVisible();
  });
}
