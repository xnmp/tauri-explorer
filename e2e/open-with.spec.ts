import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, seedSettings, switchViewMode, waitForEntries } from "./helpers";
import fs from "node:fs";
const proof = "screenshots/fix/add-open-with-to-right-click-context-menu";

async function capture(page: Page, selector: string, filename: string): Promise<void> {
  await page.locator(selector).waitFor({ state: "visible" });
  await page.locator(selector).evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
  });
  await expect.poll(() => page.locator(selector).evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
  if (selector === ".modal-overlay")
    await expect.poll(() => page.locator(".open-with-dialog").evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
  fs.mkdirSync(proof, { recursive: true });
  if (page.context().browser()?.browserType().name() === "chromium")
    await page.screenshot({ path: `${proof}/${filename}.png` });
}

test("Open with offers installed applications and cancellation does not launch", async ({ page }) => {
  await page.addInitScript(() => { (globalThis as any).__mockControl = {}; });
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  const file = page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]');
  await file.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open with…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open with" });
  await expect(dialog).toContainText("notes.md");
  await expect(dialog.getByRole("button", { name: "Text Editor", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).__mockControl.invokeCounts?.open_file_with_application ?? 0)).toBe(0);
  await expect(file).toBeVisible();
});

for (const theme of ["light", "dark"]) for (const mode of ALL_VIEW_MODES) {
  test(`${mode} ${theme}: keyboard chooses the alternate app and menu remains visible at zoom`, async ({ page }) => {
    await seedSettings(page, { theme, zoomLevel: theme === "dark" ? 150 : 100 });
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await switchViewMode(page, mode);
    const file = page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]');
    await file.click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Open Enter", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitem", { name: "Open with…", exact: true })).toBeFocused();
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    fs.mkdirSync(proof, { recursive: true });
    await capture(page, ".context-menu", `${mode}-${theme}-menu`);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Open with" });
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Alternate Editor", exact: true })).toBeFocused();
    await capture(page, ".modal-overlay", `${mode}-${theme}-chooser`);
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mock-open-with-launch")!))).toEqual({ path: "/home/user/Documents/notes.md", applicationId: "alternate-editor.desktop" });
    await expect(file).toHaveClass(/selected/);
  });
}

for (const command of ["list_open_with_applications", "open_file_with_application"]) {
  test(`${command} failure is useful and does not report success`, async ({ page }) => {
    await page.addInitScript(name => { (globalThis as any).__mockControl = { failures: { [name]: "Application test permission denied" } }; }, command);
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]').click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open with…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Open with" });
    if (command === "open_file_with_application") await dialog.getByRole("button", { name: "Alternate Editor", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Application test permission denied");
    await capture(page, ".modal-overlay", `${command}-error`);
    expect(await page.evaluate(() => localStorage.getItem("mock-open-with-launch"))).toBeNull();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}

test("an empty catalogue explains unavailable applications and cancellation stays inert", async ({ page }) => {
  await page.addInitScript(() => { (globalThis as any).__mockControl = { openWithApplications: [] }; });
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open with…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open with" });
  await expect(dialog.getByRole("status")).toContainText("No installed application");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await page.evaluate(() => (globalThis as any).__mockControl.invokeCounts?.open_file_with_application ?? 0)).toBe(0);
});

test("folders and multiple selection show an explained disabled action", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  const folder = page.locator('.entry-item[data-path="/home/user/Documents/project"]');
  await folder.click({ button: "right" });
  const action = page.getByRole("menuitem", { name: "Open with…", exact: true });
  await expect(action).toBeDisabled();
  await expect(action).toHaveAttribute("title", "Select one regular file to choose an application");
  await page.keyboard.press("Escape");
  await page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]').click();
  await page.locator('.entry-item[data-path="/home/user/Documents/report.pdf"]').click({ modifiers: ["Control"] });
  await page.locator('.entry-item[data-path="/home/user/Documents/report.pdf"]').click({ button: "right" });
  await expect(page.locator(".entry-item.selected")).toHaveCount(2);
  await expect(action).toBeDisabled();
});

test("narrow scaled chooser retains visible keyboard focus and cancel", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await seedSettings(page, { zoomLevel: 150 });
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open with…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open with" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await expect(cancel).toBeInViewport();
  await capture(page, ".modal-overlay", "narrow-150-chooser");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("accepted launch retains input ownership through Escape and a second activation", async ({ page }) => {
  await page.addInitScript(() => { (globalThis as any).__mockControl = {}; });
  await page.goto("/?path=/home/user/Documents&mockLatency=open_file_with_application:2000");
  await waitForEntries(page);
  await page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open with…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Open with" });
  await dialog.getByRole("button", { name: "Alternate Editor", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Opening file");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+P");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".command-palette-dialog")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Alternate Editor" })).toBeDisabled();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as any).__mockControl.invokeCounts.open_file_with_application)).toBe(1);
});
