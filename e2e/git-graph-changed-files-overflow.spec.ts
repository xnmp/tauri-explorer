/**
 * A commit with many changed files keeps its file list bounded and scrollable
 * instead of making the inline git-graph detail panel grow without limit (#510).
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

const MANY_FILES_COMMIT = "Add tests for feature X";
const LAST_FILE = "src/generated/many-files/file-24.ts";

test.describe("Git graph changed-files overflow (#510)", () => {
  test("AC 1: a many-file commit uses a bounded list that scrolls to its last file", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Toggle Commit Graph");
    await page.keyboard.press("Enter");

    const view = page.locator('[data-testid="git-graph-view"]');
    await expect(view.locator(".commit-row").first()).toContainText("Uncommitted Changes");
    await view.locator(".commit-row", { hasText: MANY_FILES_COMMIT }).locator(".summary").click();

    const files = view.locator(".detail-files").first();
    await expect(files.locator(".detail-file")).toHaveCount(24);

    const geometry = await files.evaluate((list) => ({
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
    }));

    // The rendered viewport, not the stylesheet, is the observable contract.
    expect(geometry.clientHeight).toBeLessThan(geometry.scrollHeight);

    await files.evaluate((list) => { list.scrollTop = list.scrollHeight; });
    await expect(files.locator(".detail-file").last()).toContainText(LAST_FILE);
    await expect(files.locator(".detail-file").last()).toBeInViewport();
  });
});
