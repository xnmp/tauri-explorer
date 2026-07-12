/**
 * E2E tests for the embedded terminal panel (issue #139) — browser/mock mode.
 *
 * A real PTY needs the Tauri binary (covered by e2e-tauri/terminal.spec.ts);
 * here we assert the panel chrome behavior: Ctrl+` toggling, xterm mounting,
 * theme-following background, and height persistence.
 */

import { test, expect } from "@playwright/test";
import { waitForEntries, HOME_URL } from "./helpers";

test.describe("Terminal panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME_URL);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForEntries(page);
  });

  test("Ctrl+` opens the panel with a live xterm instance and toggles it closed @smoke", async ({ page }) => {
    await expect(page.locator(".terminal-panel")).toHaveCount(0);

    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible({ timeout: 5000 });
    // xterm actually mounted (renders its accessibility textarea + screen).
    await expect(panel.locator(".xterm")).toBeVisible();
    await expect(panel.locator("textarea.xterm-helper-textarea")).toBeAttached();

    // Toggle closed: panel hides but stays mounted (shell session survives).
    await page.keyboard.press("Control+`");
    await expect(panel).toBeHidden();
    await expect(panel).toBeAttached();

    // And back open.
    await page.keyboard.press("Control+`");
    await expect(panel).toBeVisible();
  });

  test("Alt+M T chord toggles the panel, not just opens it (#250)", async ({ page }) => {
    await expect(page.locator(".terminal-panel")).toHaveCount(0);

    await page.keyboard.press("Alt+m");
    await page.keyboard.press("t");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible({ timeout: 5000 });

    // Pressing the chord again hides the panel (session stays mounted).
    // Focus back on the file list first — shortcuts while the terminal
    // itself is focused are issue #249's scope.
    await page.locator(".file-list").first().click();
    await page.keyboard.press("Alt+m");
    await page.keyboard.press("t");
    await expect(panel).toBeHidden();
    await expect(panel).toBeAttached();
  });

  test("app shortcuts fire while the terminal is focused (#249)", async ({ page }) => {
    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible();

    // Focus the shell's hidden textarea explicitly — app chords must still
    // reach the window handler instead of being swallowed as terminal input.
    await panel.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.press("Alt+m");
    await page.keyboard.press("t");
    await expect(panel).toBeHidden();
    await expect(panel).toBeAttached();
  });

  test("app-bound Ctrl shortcuts fire while the terminal is focused (#260)", async ({ page }) => {
    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible();
    await panel.locator("textarea.xterm-helper-textarea").focus();

    // Ctrl+P (quick open, an app binding) must win over readline history.
    await page.keyboard.press("Control+p");
    await expect(page.locator(".quick-open-dialog input.search-input")).toBeVisible();
    await page.keyboard.press("Escape");

    // Ctrl+J (hardcoded jobs panel) must fire too.
    await panel.locator("textarea.xterm-helper-textarea").focus();
    await page.keyboard.press("Control+j");
    await expect(page.getByRole("heading", { name: "Background Jobs" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("shell-critical Ctrl combos stay with the shell while focused (#260)", async ({ page }) => {
    // Select a file so an app-side Ctrl+C would visibly mark it copied.
    await page.getByText("Documents", { exact: true }).first().click();

    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible();
    await panel.locator("textarea.xterm-helper-textarea").focus();

    // Ctrl+C is whitelisted for the shell (SIGINT) — the app's copy command
    // must NOT run, so no entry gets the in-clipboard marker.
    await page.keyboard.press("Control+c");
    await expect(page.locator(".in-clipboard")).toHaveCount(0);
  });

  test("panel background follows the app theme", async ({ page }) => {
    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible();

    const readBg = () => panel.evaluate((el) => getComputedStyle(el).backgroundColor);
    const initialBg = await readBg();

    // Commit a different theme through the real picker path — the panel's
    // background is painted imperatively by the re-theme effect (#261), so a
    // bare data-theme attribute write is not the code path users hit.
    await page.locator(".file-list").first().click();
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Switch Theme");
    await page.keyboard.press("Enter");
    await page.locator(".theme-picker-dialog").waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect.poll(readBg).not.toBe(initialBg);
  });

  test("xterm colors follow a theme switch committed in the picker (#261)", async ({ page }) => {
    await page.keyboard.press("Control+`");
    await expect(page.locator(".terminal-panel")).toBeVisible();

    // xterm's DOM renderer emits its theme as a generated stylesheet — the
    // .xterm-rows color IS the painted terminal foreground.
    const rowsColor = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll("style")]
            .find((s) => s.textContent?.includes(".xterm-rows {"))
            ?.textContent?.match(/color: (#\w+)/)?.[1] ?? "",
      );
    const before = await rowsColor();
    expect(before).not.toBe("");

    // Commit a different theme through the real picker path.
    await page.locator(".file-list").first().click();
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Switch Theme");
    await page.keyboard.press("Enter");
    await page.locator(".theme-picker-dialog").waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect.poll(rowsColor).not.toBe(before);
  });

  test("a theme switched while the terminal is hidden applies when it reopens (#261)", async ({ page }) => {
    await page.keyboard.press("Control+`");
    await expect(page.locator(".terminal-panel")).toBeVisible();
    const rowsColor = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll("style")]
            .find((s) => s.textContent?.includes(".xterm-rows {"))
            ?.textContent?.match(/color: (#\w+)/)?.[1] ?? "",
      );
    const before = await rowsColor();

    // Hide the panel, then switch theme while it's display:none.
    await page.keyboard.press("Control+`");
    await expect(page.locator(".terminal-panel")).toBeHidden();
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Switch Theme");
    await page.keyboard.press("Enter");
    await page.locator(".theme-picker-dialog").waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    // Reopen — the terminal must repaint with the committed theme's colors.
    await page.keyboard.press("Control+`");
    await expect(page.locator(".terminal-panel")).toBeVisible();
    await expect.poll(rowsColor).not.toBe(before);
  });

  test("Alt+T opens the terminal and focuses it to receive the selected paths (#265)", async ({ page }) => {
    await expect(page.locator(".terminal-panel")).toHaveCount(0);
    await page.getByText("Documents", { exact: true }).first().click();

    await page.keyboard.press("Alt+t");

    // The panel opens (cold open queues the insertion until the shell
    // spawns) and the terminal takes focus so the user can keep typing.
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator("textarea.xterm-helper-textarea")).toBeFocused();
  });

  test("cwd-sync toggles appear in Settings and default to ON", async ({ page }) => {
    await page.keyboard.press("Control+,");
    const dialog = page.locator(".settings-dialog");
    await dialog.waitFor({ state: "visible", timeout: 2000 });

    for (const label of ["Terminal Follows Explorer", "Explorer Follows Terminal"]) {
      const row = dialog.locator(".setting-row", { hasText: label });
      await expect(row).toBeVisible();
      // Both default TRUE (bidirectional sync on out of the box).
      await expect(row.locator('input[type="checkbox"]')).toBeChecked();
    }
  });

  test("close button hides the panel", async ({ page }) => {
    await page.keyboard.press("Control+`");
    const panel = page.locator(".terminal-panel");
    await expect(panel).toBeVisible();

    // The header has no manual sync-to-folder button — cwd sync is automatic
    // (issue #149), so the only action is Hide.
    await panel.locator('[aria-label="Hide terminal"]').click();
    await expect(panel).toBeHidden();
  });
});
