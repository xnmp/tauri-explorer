import { test, expect, type Page, type Locator } from "./fixtures";
import { waitForEntries } from "./helpers";

const RESIZE_LOOP = "ResizeObserver loop completed with undelivered notifications";

async function openGraph(page: Page, zoom: number, width: number) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(value => {
    localStorage.setItem("explorer-settings", JSON.stringify({ zoomLevel: value }));
  }, zoom);
  await page.setViewportSize({ width, height: 720 });
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  const view = page.locator('[data-testid="git-graph-view"]');
  await expect(view.locator(".commit-row").first()).toContainText("Uncommitted Changes");
  return { view, errors };
}

async function settleResizeObservers(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }));
}

async function expectExpansionAligned(view: Locator, row: Locator, detail: Locator) {
  await expect.poll(async () => {
    const rows = view.locator(".commit-row");
    const index = await rows.evaluateAll((elements, target) => elements.indexOf(target as HTMLElement), await row.elementHandle());
    const next = rows.nth(index + 1);
    await next.scrollIntoViewIfNeeded();
    const [rowBox, detailBox, nextBox, rowCenters, vertexCenters] = await Promise.all([
      row.boundingBox(),
      detail.boundingBox(),
      next.boundingBox(),
      rows.evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return rect.top + rect.height / 2;
      })),
      // Stash rings have two circles at the same center. Compare the whole
      // ordered row/vertex sequence so a different commit cannot satisfy it.
      view.locator(".graph-underlay circle").evaluateAll(circles => [...new Set(circles.map(circle => {
        const rect = circle.getBoundingClientRect();
        return rect.top + rect.height / 2;
      }))]),
    ]);
    if (rowCenters.length !== vertexCenters.length) return Infinity;
    if (!rowBox || !detailBox || !nextBox) return null;
    const zoom = rowBox.height / 28;
    return Math.max(
      Math.abs(rowBox.y + rowBox.height - detailBox.y),
      Math.abs(detailBox.y + detailBox.height + 6 * zoom - nextBox.y),
      ...vertexCenters.map((center, index) => Math.abs(center - rowCenters[index])),
    );
  }).toBeLessThanOrEqual(1);
}

test("expanded commit metadata keeps rows and vertices aligned without observer feedback", async ({ page }) => {
  const { view, errors } = await openGraph(page, 100, 1280);
  const row = view.locator(".commit-row", { hasText: "Merge hotfix into main" });
  await row.click();
  const detail = view.getByTestId("git-graph-detail");
  await expect(detail).toBeVisible();
  await view.locator(".graph-header").click({ button: "right" });
  await view.getByTestId("toggle-detail-meta").click();
  await page.keyboard.press("Escape");
  await expect(detail).toContainText("merge of 2 parents");
  await settleResizeObservers(page);
  await expectExpansionAligned(view, row, detail);
  expect(errors.filter(message => message.includes(RESIZE_LOOP))).toEqual([]);
  await page.screenshot({ path: "screenshots/refactor/repo-health-cleanup/graph-detail-layout.png" });
});

test("PR detail remains aligned in a narrow zoomed graph without observer feedback", async ({ page }) => {
  const { view, errors } = await openGraph(page, 150, 900);
  const row = view.locator(".commit-row", { hasText: "Add tests for feature X" });
  await row.locator(".ref-pr").click();
  const detail = view.getByTestId("git-graph-pr-detail");
  await expect(detail).toContainText("Add feature X");
  await settleResizeObservers(page);
  await expectExpansionAligned(view, row, detail);
  expect(errors.filter(message => message.includes(RESIZE_LOOP))).toEqual([]);
});
