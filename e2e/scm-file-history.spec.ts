/**
 * Per-file commit history from the SCM Files pane (#518).
 *
 * The test drives the visible SCM action through to the graph query seam.
 * The mock graph assigns `src/index.css` to one commit only, so it proves
 * the graph is filtered rather than merely opened.
 */
import { test, expect, type Page } from "./fixtures";

async function openScmOnRepo(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    const raw = localStorage.getItem("explorer-settings");
    const settings = raw ? JSON.parse(raw) : {};
    settings.showGitStatus = true;
    settings.showScmPanel = true;
    settings.scmTreeView = false;
    localStorage.setItem("explorer-settings", JSON.stringify(settings));
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();
}

test.describe("SCM per-file commit history (#518)", () => {
  test("shows only the selected file's history in the git graph", async ({ page }) => {
    await openScmOnRepo(page);

    const scm = page.locator(".scm-panel").first();
    const fileRow = scm.locator('.row[data-path="src/index.css"]');
    await expect(fileRow).toBeVisible();
    await fileRow.hover();

    await fileRow.getByRole("button", { name: "Show history for src/index.css" }).click();

    const graph = page.locator('[data-testid="git-graph-view"]');
    await expect(graph).toBeVisible();
    await expect(graph.locator(".gh-message")).toHaveText("Path: src/index.css");
    await expect(graph.locator(".commit-row")).toHaveCount(1);
    await expect(graph.locator(".commit-row")).toContainText("Merge branch 'feature'");
    await expect(graph).not.toContainText("Add tests for feature X");
    await page.screenshot({ path: "evidence/ac-1-scm-file-history.png" });
  });
});
