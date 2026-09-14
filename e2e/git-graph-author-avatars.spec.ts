import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraph(page: import("@playwright/test").Page, firstRow = "Uncommitted Changes") {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="git-graph-view"] .commit-row').first())
    .toContainText(firstRow);
}

test("commit rows expose resolved and deterministic fallback avatars", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraph(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const resolved = view.locator(".commit-row", { hasText: "Merge hotfix into main" });
  const fallback = view.locator(".commit-row", { hasText: "Merge experiment" });
  await expect(resolved.locator('[data-testid="author-avatar"] img')).toBeVisible();
  await expect(fallback.locator('[data-testid="author-avatar-fallback"]')).toHaveText("B");
  await expect(resolved).toHaveCSS("height", "28px");
  await page.screenshot({ path: "evidence/ac-1-resolved-avatar.png" });
  await fallback.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "evidence/ac-2-fallback-avatar.png" });

  const fallbackStyle = await fallback.locator('[data-testid="author-avatar-fallback"]').getAttribute("style");
  await page.reload();
  await waitForEntries(page);
  await openGraph(page);
  await expect(view.locator(".commit-row", { hasText: "Merge experiment" })
    .locator('[data-testid="author-avatar-fallback"]')).toHaveAttribute("style", fallbackStyle!);
});

test("avatar display and Gravatar consent persist independently", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("git-graph-columns")) {
      localStorage.setItem("git-graph-columns", JSON.stringify({ author: true, date: false, commit: true, parent: true }));
    }
  });
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraph(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  await expect(view.locator('[data-testid="author-avatar"] img').first()).toBeVisible();
  await expect(view.locator(".gh-date")).toHaveCount(0);
  await expect(view.locator(".gh-parent")).toBeVisible();
  await page.locator(".graph-header").click({ button: "right" });
  const menu = page.locator('[data-testid="git-graph-column-menu"]');
  await expect(menu.locator('[data-testid="toggle-author-avatars"]')).toHaveAttribute("aria-checked", "true");
  const consent = menu.locator('[data-testid="toggle-gravatar"]');
  await expect(consent).toHaveAttribute("aria-checked", "false");
  await expect(menu).toContainText("hashed author emails, including private repositories");
  await page.screenshot({ path: "evidence/ac-4-gravatar-opt-in.png" });

  await consent.click();
  await page.reload();
  await waitForEntries(page);
  await openGraph(page);
  await page.locator(".graph-header").click({ button: "right" });
  await expect(page.locator('[data-testid="toggle-gravatar"]')).toHaveAttribute("aria-checked", "true");

  const lookupsBeforeOff = await page.evaluate(() => Number(localStorage.getItem("mock-avatar-lookups") ?? "0"));
  await page.locator('[data-testid="toggle-author-avatars"]').click();
  await expect(view.locator('[data-testid="author-avatar"]')).toHaveCount(0);
  await page.reload();
  await waitForEntries(page);
  await openGraph(page);
  await expect(view.locator('[data-testid="author-avatar"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Number(localStorage.getItem("mock-avatar-lookups") ?? "0"))).toBe(lookupsBeforeOff);
  await expect(view.locator(".gh-date")).toHaveCount(0);
  await expect(view.locator(".gh-parent")).toBeVisible();
  await page.locator(".graph-header").click({ button: "right" });
  await expect(page.locator('[data-testid="toggle-author-avatars"]')).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: "evidence/ac-3-avatar-toggle-off.png" });
});

test("avatars stay aligned while virtualized history recycles rows", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/load-repo-0&mockGitCommits=750");
  await waitForEntries(page);
  await openGraph(page, "Release build 750 [load-repo-0]");
  const view = page.locator('[data-testid="git-graph-view"]');
  const scroller = view.locator(".graph-scroller");
  const firstSummary = await view.locator(".commit-row .summary").first().textContent();
  await scroller.evaluate((element) => { element.scrollTop = 9_000; element.dispatchEvent(new Event("scroll")); });
  await expect.poll(() => view.locator(".commit-row .summary").first().textContent()).not.toBe(firstSummary);
  const rows = view.locator(".commit-row");
  expect(await rows.count()).toBeLessThan(100);
  await expect(rows.locator('[data-testid="author-avatar"]').first()).toBeVisible();
  await expect(rows.first()).toHaveCSS("height", "28px");
});

test("failed avatar lookup leaves the graph usable", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project&mockAvatarFailure=1");
  await waitForEntries(page);
  await openGraph(page);
  const view = page.locator('[data-testid="git-graph-view"]');
  await expect(view.locator('[data-testid="author-avatar-fallback"]')).not.toHaveCount(0);
  await expect(view.locator(".commit-row", { hasText: "Initial commit" })).toBeVisible();
  await page.screenshot({ path: "evidence/ac-5-failure-fallback.png" });
});
