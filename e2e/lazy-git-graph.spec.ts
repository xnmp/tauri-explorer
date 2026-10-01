import { expect, test } from "./fixtures";
import { waitForEntries } from "./helpers";

test("file browsing does not request the graph view and a failed first open remains recoverable", async ({ page }) => {
  let graphRequests = 0;
  await page.route("**/GitGraphView.svelte*", (route) => {
    graphRequests++;
    return route.abort();
  });
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  expect(graphRequests).toBe(0);

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Could not load Git history");
  expect(graphRequests).toBeGreaterThan(0);
  await page.screenshot({ path: "screenshots/refactor/repo-health-cleanup/graph-load-recovery.png" });
  await page.getByRole("button", { name: "Return to files" }).click();
  const file = page.locator(".entry-item").first();
  await expect(file).toBeVisible();
  await page.keyboard.press("Control+a");
  await expect(file).toHaveClass(/selected/);
});
