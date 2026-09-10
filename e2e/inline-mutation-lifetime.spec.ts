/** Editor completion belongs to one opening, including reopening the same path. */
import { test, expect } from "./fixtures";
import { ALL_VIEW_MODES, waitForEntries } from "./helpers";

for (const viewMode of ALL_VIEW_MODES) {
  test.describe(`Inline mutation lifetime [${viewMode}]`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/?path=/home/user&viewMode=${viewMode}`);
      await waitForEntries(page);
      await page.locator('.entry-item[data-path="/home/user/readme.txt"]').click();
      await page.keyboard.press("F2");
      await expect(page.locator(".rename-input")).toBeFocused();
    });

    test("an asynchronous rename error keeps the editor usable without refocusing", async ({ page }) => {
      await page.evaluate(async () => {
        const modulePath = "/src/lib/state/window-tabs.svelte.ts";
        const { windowTabsManager } = await import(/* @vite-ignore */ modulePath);
        const explorer = windowTabsManager.getActiveExplorer();
        // Exercise the editor's error contract; no backend behavior is inferred.
        explorer.rename = () => new Promise((resolve) => {
          window.addEventListener("test-rename-error", () => resolve("Permission denied"), { once: true });
        });
      });
      const input = page.locator(".rename-input");
      await input.fill("renamed.txt");
      await page.keyboard.press("Enter");
      await page.evaluate(() => window.dispatchEvent(new Event("test-rename-error")));
      await expect(input).toHaveClass(/error/);
      await expect(input).toBeFocused();
      if (viewMode === "details") await page.screenshot({
        path: "screenshots/refactor/repo-health-cleanup/rename-error-retry.png",
      });
      await page.keyboard.press("Control+A");
      await page.keyboard.type("retry.txt");
      await expect(input).toHaveValue("retry.txt");
    });

    test("an old failure cannot disable or overwrite a reopened editor", async ({ page }) => {
      await page.evaluate(async () => {
        const modulePath = "/src/lib/state/window-tabs.svelte.ts";
        const { windowTabsManager } = await import(/* @vite-ignore */ modulePath);
        const explorer = windowTabsManager.getActiveExplorer();
        explorer.rename = () => new Promise((resolve) => {
          window.addEventListener("test-rename-error", () => resolve("Old failure"), { once: true });
        });
      });
      const input = page.locator(".rename-input");
      await input.fill("first-attempt.txt");
      await page.keyboard.press("Enter");
      await page.evaluate(async () => {
        const modulePath = "/src/lib/state/window-tabs.svelte.ts";
        const { windowTabsManager } = await import(/* @vite-ignore */ modulePath);
        const explorer = windowTabsManager.getActiveExplorer();
        const entry = explorer.displayEntries.find((item: { path: string }) => item.path === "/home/user/readme.txt");
        explorer.startRename(entry);
      });
      await expect(input).toHaveValue("readme.txt");
      await expect(input).toBeFocused();
      await input.fill("new-session.txt");
      await page.evaluate(() => window.dispatchEvent(new Event("test-rename-error")));
      await expect(input).toHaveValue("new-session.txt");
      await expect(input).not.toHaveClass(/error/);
      await expect(input).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(input).toHaveCount(0);
    });

    test("successful rename teardown stays single-owned without stale derived reads", async ({ page }) => {
      const derivedWarnings: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "warning" && message.text().includes("[svelte] derived_inert")) {
          derivedWarnings.push(message.text());
        }
      });

      const enteredName = `entered-${viewMode}.txt`;
      const enteredPath = `/home/user/${enteredName}`;
      const input = page.locator(".rename-input");
      await input.fill(enteredName);
      await page.keyboard.press("Enter");

      await expect(page.locator(`.entry-item[data-path="${enteredPath}"]`)).toBeVisible();
      await expect(page.locator('.entry-item[data-path="/home/user/readme.txt"]')).toHaveCount(0);
      await expect(input).toHaveCount(0);

      await page.locator(`.entry-item[data-path="${enteredPath}"]`).click();
      await page.keyboard.press("F2");
      await expect(input).toBeFocused();

      const clickAwayName = `click-away-${viewMode}.txt`;
      const clickAwayPath = `/home/user/${clickAwayName}`;
      await input.fill(clickAwayName);
      await page.locator('.entry-item[data-path="/home/user/Documents"]').click();

      await expect(page.locator(`.entry-item[data-path="${clickAwayPath}"]`)).toBeVisible();
      await expect(page.locator(`.entry-item[data-path="${enteredPath}"]`)).toHaveCount(0);
      await expect(input).toHaveCount(0);
      expect(derivedWarnings).toEqual([]);
    });
  });
}
