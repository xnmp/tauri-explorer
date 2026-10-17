import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

for (const shortcut of ["Ctrl+P", "Alt+M T"]) {
  test(`terminal ownership retains the eligible command when ${shortcut} conflicts`, async ({ page }) => {
    await page.addInitScript((shortcut) => {
      // Navigation commands precede dialog/terminal commands in the registry.
      // A user override makes the old broad second lookup select Go Up.
      localStorage.setItem("explorer-keybindings", JSON.stringify({ "navigation.goUp": shortcut }));
    }, shortcut);
    await page.goto(HOME_URL);
    await waitForEntries(page);
    const pathBefore = await page.locator(".status-path").getAttribute("title");
    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible();
    await panel.locator("textarea.xterm-helper-textarea").focus();
    if (shortcut === "Ctrl+P") {
      await page.keyboard.press("Control+p");
      await expect(page.locator(".quick-open-dialog")).toBeVisible();
      await page.locator(".quick-open-dialog input").fill("Documents");
      await expect(page.locator(".quick-open-dialog")).toContainText("Documents");
      await page.screenshot({ path: "screenshots/refactor/repo-health-cleanup/keyboard-command-ownership.png" });
    } else {
      await page.keyboard.press("Alt+m");
      await page.keyboard.press("t");
      await expect(panel).toBeHidden();
    }
    await expect(page.locator(".status-path")).toHaveAttribute("title", pathBefore!);
  });
}

test("window blur cancels a chord before the next focus session", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.locator(".file-list").first().click();
  await page.keyboard.press("Alt+m");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.keyboard.press("t");
  await expect(page.locator(".terminal-panel")).toHaveCount(0);
  // A new complete chord still works after the ownership boundary.
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("t");
  await expect(page.locator(".terminal-panel")).toBeVisible();
});

test("deferred terminal layout preserves the newer dialog's input ownership", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  // Hold animation callbacks across a real input handoff, then let layout
  // finish. This reproduces delayed frames without relying on machine load.
  await page.evaluate(() => {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map<number, FrameRequestCallback>();
    let nextId = -1;
    window.requestAnimationFrame = (callback) => {
      const id = nextId--;
      pending.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!pending.delete(id)) cancel(id);
    };
    (window as unknown as { releaseLayout(): Promise<void> }).releaseLayout = () => {
      window.requestAnimationFrame = request;
      window.cancelAnimationFrame = cancel;
      for (const callback of pending.values()) request(callback);
      pending.clear();
      return new Promise((resolve) => request(() => request(() => resolve())));
    };
  });
  await page.keyboard.press("Control+`");
  const terminal = page.locator(".terminal-panel textarea.xterm-helper-textarea");
  await terminal.waitFor({ state: "attached" });
  await terminal.focus();
  await page.keyboard.press("Control+p");
  const input = page.locator(".quick-open-dialog input.search-input");
  await expect(input).toBeFocused();
  await page.evaluate(() => (window as unknown as { releaseLayout(): Promise<void> }).releaseLayout());
  // Snapshot after the held work settled: retrying could hide stolen focus.
  expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
  await page.keyboard.type("Documents");
  await expect(page.locator(".quick-open-dialog")).toContainText("Documents");
  await page.keyboard.press("Escape");
  await expect(page.locator(".quick-open-dialog")).toBeHidden();
});

for (const destination of ["dialog", "filter"] as const) {
  test(`cold terminal import preserves a newer ${destination} interaction`, async ({ page }) => {
    let release!: () => void;
    let requested!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const request = new Promise<void>((resolve) => { requested = resolve; });
    await page.route("**/TerminalPanel.svelte*", async (route) => {
      requested();
      await held;
      await route.continue();
    });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await page.keyboard.press("Control+`");
    await request;
    await page.keyboard.press(destination === "dialog" ? "Control+p" : "Control+f");
    const input = page.locator(destination === "dialog" ? ".quick-open-dialog input.search-input" : ".filter-input");
    await expect(input).toBeFocused();
    release();
    await expect(page.locator(".terminal-panel .xterm")).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.type("Documents");
    await expect(input).toHaveValue("Documents");
    if (destination === "dialog") {
      await expect(page.locator(".quick-open-dialog")).toContainText("Documents");
      await page.keyboard.press("Escape");
      await expect(page.locator(".quick-open-dialog")).toBeHidden();
    } else {
      await expect(page.locator(".entry-item .entry-name")).toHaveText(["Documents"]);
    }
  });
}
