/**
 * Inline diff viewer (#55).
 *
 * Clicking a file in the SCM panel opens a diff in the preview pane.
 * The preview pane shows staged/unstaged badges, diff lines, and
 * action buttons. Clicking another file switches the diff.
 */
import { test, expect, type Page } from "@playwright/test";

async function openScmOnRepo(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => {
    const raw = localStorage.getItem("explorer-settings");
    const s = raw ? JSON.parse(raw) : {};
    s.showGitStatus = true;
    s.showScmPanel = true;
    s.showPreviewPane = true;
    localStorage.setItem("explorer-settings", JSON.stringify(s));
  });
  await page.reload();
  await page.waitForLoadState("domcontentloaded");

  // Walk the pane: /home → /home/user → Documents → project.
  await page.getByText("Documents", { exact: true }).first().dblclick();
  await page.getByText("project", { exact: true }).first().dblclick();

  await page.locator('[data-section="staged"]').waitFor({ state: "visible" });
}

test.describe("SCM inline diff viewer", () => {
  test("clicking a staged row shows diff in preview pane", async ({ page }) => {
    await openScmOnRepo(page);

    await page.locator('[data-section="staged"] .row', { hasText: "App.tsx" }).click();

    const previewPane = page.locator(".preview-pane");
    await expect(previewPane).toBeVisible();
    await expect(previewPane.locator(".preview-filename")).toHaveText("App.tsx");
    await expect(previewPane.locator(".diff-staged")).toBeVisible();
    // Mock diff contains at least one add + one remove line.
    await expect(previewPane.locator('.diff-line[data-line-kind="add"]').first()).toBeVisible();
    await expect(previewPane.locator('.diff-line[data-line-kind="remove"]').first()).toBeVisible();
  });

  test("clicking unstaged row shows unstaged badge", async ({ page }) => {
    await openScmOnRepo(page);

    await page.locator('[data-section="changes"] .row', { hasText: "index.css" }).click();

    const previewPane = page.locator(".preview-pane");
    await expect(previewPane).toBeVisible();
    await expect(previewPane.locator(".diff-unstaged")).toBeVisible();
  });

  test("switching files updates the diff without requiring a close", async ({ page }) => {
    await openScmOnRepo(page);

    await page.locator('[data-section="staged"] .row', { hasText: "App.tsx" }).click();
    await expect(page.locator(".preview-pane .preview-filename")).toHaveText("App.tsx");

    await page.locator('[data-section="changes"] .row', { hasText: "README.md" }).click();
    await expect(page.locator(".preview-pane .preview-filename")).toHaveText("README.md");
  });

  test("diff shows file path in info section", async ({ page }) => {
    await openScmOnRepo(page);

    await page.locator('[data-section="staged"] .row', { hasText: "App.tsx" }).click();

    const infoValue = page.locator(".preview-pane .info-value");
    await expect(infoValue).toHaveText("src/App.tsx");
  });

  test("a slow diff still lands while poll refreshes rain on it (#396)", async ({ page }) => {
    // A repo on a UNC path is polled every 3s (#387); each poll replaces the
    // SCM summary, which the preview's diff effect depends on. Before the fix
    // every refresh superseded the in-flight request, so on a slow share the
    // diff never rendered: the pane flashed a spinner and settled on
    // "No changes to display". Reproduce with a slow git_diff + a poll storm.
    await page.goto("/");
    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.showGitStatus = true;
      s.showScmPanel = true;
      s.showPreviewPane = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    // A diff slower than the poll interval is the whole point: every poll used
    // to supersede the request in flight, so none could ever finish.
    await page.goto("/?mockLatency=git_diff:1200");
    await page.waitForLoadState("domcontentloaded");
    await page.getByText("Documents", { exact: true }).first().dblclick();
    await page.getByText("project", { exact: true }).first().dblclick();
    await page.locator('[data-section="staged"]').waitFor({ state: "visible" });

    await page.locator('[data-section="staged"] .row', { hasText: "App.tsx" }).click();

    // Keep polling THROUGHOUT the assertion below (not before it): starvation
    // only bites while the refreshes keep coming.
    await page.evaluate(() => {
      const w = window as unknown as { __mockGitPoll?: () => void; __stormId?: number };
      w.__stormId = window.setInterval(() => w.__mockGitPoll?.(), 400);
    });

    const previewPane = page.locator(".preview-pane");
    await expect(previewPane.locator('.diff-line[data-line-kind="add"]').first()).toBeVisible({
      timeout: 6000,
    });
    await expect(previewPane.getByText("No changes to display")).toHaveCount(0);

    await page.evaluate(() => {
      const w = window as unknown as { __stormId?: number };
      if (w.__stormId) clearInterval(w.__stormId);
    });

    // Not wedged on a spinner once the storm subsides.
    await expect(previewPane.locator(".spinner")).toHaveCount(0);
    await expect(previewPane.locator('.diff-line[data-line-kind="add"]').first()).toBeVisible();
  });

  test("selecting a file in the explorer clears the diff", async ({ page }) => {
    await openScmOnRepo(page);

    // Open a diff
    await page.locator('[data-section="staged"] .row', { hasText: "App.tsx" }).click();
    await expect(page.locator(".preview-pane .diff-staged")).toBeVisible();

    // Click a file in the explorer pane
    await page.locator(".entry-item", { hasText: "README.md" }).first().click();

    // Diff badge should disappear (preview switches to file preview)
    await expect(page.locator(".preview-pane .diff-staged")).toHaveCount(0, { timeout: 3000 });
  });
});
