import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraph(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="git-graph-view"] .commit-row').first())
    .toContainText("Uncommitted Changes");
}

test("commit rows expose resolved and deterministic fallback avatars", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraph(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const resolved = view.locator(".commit-row", { hasText: "Merge hotfix into main" });
  const fallback = view.locator(".commit-row", { hasText: "Try alternative parser" });
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
  await expect(view.locator(".commit-row", { hasText: "Try alternative parser" })
    .locator('[data-testid="author-avatar-fallback"]')).toHaveAttribute("style", fallbackStyle!);
});

test("avatar display and Gravatar consent persist independently", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraph(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  await page.locator(".graph-header").click({ button: "right" });
  const menu = page.locator('[data-testid="git-graph-column-menu"]');
  await expect(menu.getByText("Author avatars", { exact: true })).toHaveAttribute("aria-checked", "true");
  const consent = menu.locator('[data-testid="toggle-gravatar"]');
  await expect(consent).toHaveAttribute("aria-checked", "false");
  await expect(menu).toContainText("hashed author emails, including private repositories");
  await page.screenshot({ path: "evidence/ac-4-gravatar-opt-in.png" });

  await menu.getByText("Author avatars", { exact: true }).click();
  await expect(view.locator('[data-testid="author-avatar"]')).toHaveCount(0);
  await page.reload();
  await waitForEntries(page);
  await openGraph(page);
  await expect(view.locator('[data-testid="author-avatar"]')).toHaveCount(0);
  await page.locator(".graph-header").click({ button: "right" });
  await expect(page.locator('[data-testid="toggle-author-avatars"]')).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: "evidence/ac-3-avatar-toggle-off.png" });
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
