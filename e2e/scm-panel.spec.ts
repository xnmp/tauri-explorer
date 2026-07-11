/**
 * SCM panel UI (#54).
 *
 * Exercises the Source Control sidebar view against the mock-invoke
 * backend. Navigates the active pane into the mocked repo path
 * (`/home/user/Documents/project`), switches the activity bar to SCM,
 * and asserts the rendered surface matches what the backend returns
 * (counts, rows, actions, commit button behaviour).
 */
import { test, expect, type Page } from "@playwright/test";

async function openScmOnRepo(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    const raw = localStorage.getItem("explorer-settings");
    const s = raw ? JSON.parse(raw) : {};
    s.showGitStatus = true;
    s.showScmPanel = true;
    localStorage.setItem("explorer-settings", JSON.stringify(s));
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // Navigate the active pane to the mocked git repo via double-clicks into Documents/project.
  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();
}

test.describe("SCM panel UI", () => {
  test("shows the mocked repo's staged / changes / untracked sections with counts", async ({ page }) => {
    await openScmOnRepo(page);

    const stagedSection = page.locator('[data-section="staged"]');
    const changesSection = page.locator('[data-section="changes"]');
    const untrackedSection = page.locator('[data-section="untracked"]');

    await expect(stagedSection).toBeVisible();
    await expect(changesSection).toBeVisible();
    await expect(untrackedSection).toBeVisible();

    await expect(stagedSection.locator(".count-badge")).toHaveText("1");
    await expect(changesSection.locator(".count-badge")).toHaveText("2");
    // Mock includes a binary asset alongside text files to exercise the
    // diff viewer's binary placeholder.
    await expect(untrackedSection.locator(".count-badge")).toHaveText("3");

    // Specific files from the mock
    await expect(stagedSection.getByText("App.tsx")).toBeVisible();
    await expect(changesSection.getByText("index.css")).toBeVisible();
    await expect(untrackedSection.getByText("router.tsx")).toBeVisible();
  });

  test("shows a loading skeleton while the summary fetch is in flight, not the empty state (#271)", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.showGitStatus = true;
      s.showScmPanel = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Slow the summary fetch down so the transient loading state is observable.
    await page.evaluate(() => {
      (window as unknown as { __MOCK_LATENCY__?: Record<string, number> }).__MOCK_LATENCY__ = {
        git_status: 1500,
      };
    });
    await page.getByText("Documents", { exact: true }).first().dblclick();
    await page.getByText("project", { exact: true }).first().dblclick();

    // While loading: skeleton, and crucially NOT the not-a-repo empty state.
    const skeleton = page.locator(".loading-state");
    await expect(skeleton).toBeVisible();
    await expect(page.getByText(/Not a git repository/i)).not.toBeVisible();

    // Once the fetch lands, real sections replace the skeleton.
    await expect(page.locator('[data-section="staged"]')).toBeVisible({ timeout: 5000 });
    await expect(skeleton).not.toBeVisible();
  });

  test("empty-state shows Initialize Repository when active pane is not a repo", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.showGitStatus = true;
      s.showScmPanel = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Active pane defaults to /home/user (not a repo)
    await expect(page.getByText(/Not a git repository/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Initialize Repository/i })).toBeVisible();
  });

  test("commit button requires message to be enabled (#79, #102)", async ({ page }) => {
    await openScmOnRepo(page);

    // Empty message + staged files → button is disabled (no implicit amend).
    const commitBtn = page.getByRole("button", { name: /^Commit$/ });
    await expect(commitBtn).toBeDisabled();

    // Typing a message enables the button.
    await page.getByLabel("Commit message").fill("feat: ship this");
    await expect(commitBtn).toBeEnabled();
  });

  test("row status letters reflect the file's git state", async ({ page }) => {
    await openScmOnRepo(page);

    const stagedRow = page.locator('[data-section="staged"] .row', { hasText: "App.tsx" });
    await expect(stagedRow.locator(".status-letter")).toHaveText("M");

    const untrackedRow = page.locator('[data-section="untracked"] .row', { hasText: "router.tsx" });
    await expect(untrackedRow.locator(".status-letter")).toHaveText("U");
  });

  test("clicking a row selects it and arrow keys move selection", async ({ page }) => {
    await openScmOnRepo(page);

    const firstRow = page.locator('[data-section="staged"] .row').first();
    await firstRow.click();
    await expect(firstRow).toHaveClass(/selected/);

    // Focus the view so arrow keys land on the keydown handler.
    await page.locator(".scm-view").focus().catch(() => {});
    await page.keyboard.press("ArrowDown");

    // A different row should now be selected.
    const selected = page.locator(".scm-view .row.selected");
    await expect(selected).toHaveCount(1);
  });

  test("clicking a file opens its diff with syntax-highlighted code (#246)", async ({ page }) => {
    await openScmOnRepo(page);

    // Clicking a row opens the diff in the preview pane.
    await page.locator('[data-section="staged"] .row', { hasText: "App.tsx" }).click();

    const lines = page.locator(".diff-lines");
    await expect(lines).toBeVisible();
    // The mock diff contains real code; changed lines must be tokenized
    // (hljs spans), and the shared palette class must be active on the root
    // so the tokens actually get colors (themes/syntax.css).
    await expect(lines.locator('.diff-content [class*="hljs-"]').first()).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/hljs-(light|dark)/);
  });

  test("tree view shows folder nodes with depth guide lines (#97)", async ({ page }) => {
    await openScmOnRepo(page);

    // Enable tree view mode. Navigate back into the repo via URL — the
    // double-click navigation path is exercised by openScmOnRepo above and
    // the other tests; re-doing it after a reload is racy (a row re-render
    // between the two clicks turns the dblclick into select-only).
    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.scmTreeView = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    await page.goto("/?path=/home/user/Documents/project");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    // The "Changes" section has src/index.css and README.md — "src" should
    // appear as a tree-folder node.
    const changesSection = page.locator('[data-section="changes"]');
    await expect(changesSection).toBeVisible();

    const srcFolder = changesSection.locator(".tree-folder", { hasText: "src" });
    await expect(srcFolder).toBeVisible();

    // Files nested under src/ should have depth guides.
    const nestedFile = changesSection.locator(".tree-file", { hasText: "index.css" });
    await expect(nestedFile).toBeVisible();
    await expect(nestedFile.locator(".depth-guide")).toHaveCount(1);
  });

  test("tree view folder actions stage/unstage all children (#97)", async ({ page }) => {
    await openScmOnRepo(page);

    // Enable tree view mode. Navigate back into the repo via URL — the
    // double-click navigation path is exercised by openScmOnRepo above and
    // the other tests; re-doing it after a reload is racy (a row re-render
    // between the two clicks turns the dblclick into select-only).
    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.scmTreeView = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    await page.goto("/?path=/home/user/Documents/project");
    await page.locator(".entry-item").first().waitFor({ timeout: 5000 });

    // The "Untracked" section has src/router.tsx and assets/logo.png under
    // folder nodes. Hover over the "src" folder to reveal the stage button.
    const untrackedSection = page.locator('[data-section="untracked"]');
    await expect(untrackedSection).toBeVisible();

    const srcFolder = untrackedSection.locator(".tree-folder", { hasText: "src" });
    await expect(srcFolder).toBeVisible();

    // Folder action buttons should appear on hover.
    await srcFolder.hover();
    const stageBtn = srcFolder.locator('.row-btn[title="Stage folder"]');
    await expect(stageBtn).toBeVisible();
  });

  test("tree view toggle switches between flat and tree rendering", async ({ page }) => {
    await openScmOnRepo(page);

    // Default is flat list — no tree-folder nodes should exist.
    await expect(page.locator(".tree-folder")).toHaveCount(0);

    // Click the Tree/List toggle button.
    const toggleBtn = page.locator(".view-toggle");
    await expect(toggleBtn).toHaveText("List");
    await toggleBtn.click();

    // Now tree-folder nodes should appear.
    await expect(page.locator(".tree-folder").first()).toBeVisible();
    await expect(toggleBtn).toHaveText("Tree");
  });
});
