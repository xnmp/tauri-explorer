/**
 * SCM sidebar fuzzy filter (#517).
 *
 * Drives the real sidebar against the mock-invoke backend (6 pending files)
 * and asserts the rendered rows narrow to fuzzy matches. Screenshots for the
 * issue's acceptance criteria are captured here, right after the assertion
 * that puts the panel into the state each image claims to show.
 */
import { test, expect, type Page } from "./fixtures";

async function openScmOnRepo(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    const raw = localStorage.getItem("explorer-settings");
    const s = raw ? JSON.parse(raw) : {};
    s.showGitStatus = true;
    s.showScmPanel = true;
    s.scmTreeView = false;
    localStorage.setItem("explorer-settings", JSON.stringify(s));
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();
}

test.describe("SCM sidebar fuzzy filter (#517)", () => {
  test("narrows the pending file list to fuzzy matches", async ({ page }) => {
    await openScmOnRepo(page);

    const panel = page.locator(".scm-panel").first();
    const view = panel.locator(".scm-view");
    const rows = view.locator(".row-list .row");
    const input = view.locator(".scm-filter-input");

    // AC1: the filter input exists and an empty query shows every file.
    await expect(input).toBeVisible();
    await expect(rows).toHaveCount(6);
    await expect(view.locator('[data-section="staged"] .count-badge')).toHaveText("1");
    await expect(view.locator('[data-section="changes"] .count-badge')).toHaveText("2");
    await expect(view.locator('[data-section="untracked"] .count-badge')).toHaveText("3");
    await panel.screenshot({ path: "evidence/ac-1-filter-input-unfiltered.png" });

    // AC2: a fuzzy, non-substring query narrows the list to its matches.
    await input.fill("idx");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("index.css");
    await expect(view.locator('[data-section="changes"] .count-badge')).toHaveText("1");
    await expect(view.locator('[data-section="staged"] .count-badge')).toHaveText("0");
    await expect(view.locator('[data-section="untracked"] .count-badge')).toHaveText("0");
    await panel.screenshot({ path: "evidence/ac-2-fuzzy-query-narrows.png" });

    // AC3: no matches reads as "no matches", not "working tree clean".
    await input.fill("zzzz");
    await expect(rows).toHaveCount(0);
    await expect(view.locator(".scm-no-match")).toBeVisible();
    await expect(view.locator(".clean-state")).toHaveCount(0);
    await panel.screenshot({ path: "evidence/ac-3-no-match-message.png" });

    // Clearing the query restores the full list.
    await input.fill("");
    await expect(rows).toHaveCount(6);
    await expect(view.locator(".scm-no-match")).toHaveCount(0);
  });

  test("Escape clears the filter and keeps the full list", async ({ page }) => {
    await openScmOnRepo(page);
    const view = page.locator(".scm-panel").first().locator(".scm-view");
    const input = view.locator(".scm-filter-input");

    await input.fill("logo");
    await expect(view.locator(".row-list .row")).toHaveCount(1);

    await input.press("Escape");
    await expect(input).toHaveValue("");
    await expect(view.locator(".row-list .row")).toHaveCount(6);
  });

  test("filtering does not change what a commit acts on", async ({ page }) => {
    await openScmOnRepo(page);
    const view = page.locator(".scm-panel").first().locator(".scm-view");

    // A query that hides every staged file must not disable the Commit
    // button — commits stay repo-wide.
    await view.locator(".scm-filter-input").fill("logo");
    await expect(view.locator('[data-section="staged"] .count-badge')).toHaveText("0");
    await view.locator(".commit-message").fill("filtered commit");
    await expect(view.locator(".commit-btn")).toBeEnabled();
  });
});
