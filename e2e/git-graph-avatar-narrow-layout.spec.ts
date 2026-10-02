import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraph(page: Page) {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  const view = page.getByTestId("git-graph-view");
  await expect(view.locator(".commit-row").first()).toContainText("Uncommitted Changes");
  return view;
}

test("visible avatars do not widen narrow commit details beyond the graph viewport", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 800 });
  const view = await openGraph(page);
  await expect(view.getByTestId("author-avatar").first()).toBeVisible();

  await view
    .locator(".commit-row", { hasText: "Fix bug in argument parser" })
    .locator(".summary")
    .click();
  const detail = view.getByTestId("git-graph-detail");
  await expect(detail).toBeVisible();

  // The existing metadata columns require 88px of horizontal overflow in
  // Chromium and 96px in WebKit for this fixture. Avatars belong inside the
  // flexible message cell and must not add their own 28px to that boundary.
  await expect.poll(() => view.evaluate((root) => {
    const scroller = root.querySelector<HTMLElement>(".graph-scroller");
    const panel = root.querySelector<HTMLElement>(".commit-detail-inline");
    if (!scroller || !panel) return Number.POSITIVE_INFINITY;
    return Math.max(
      scroller.scrollWidth - scroller.clientWidth,
      panel.getBoundingClientRect().right - scroller.getBoundingClientRect().right,
    );
  })).toBeLessThanOrEqual(100);
});
