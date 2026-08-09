import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraphViaPalette(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="git-graph-view"] .commit-row').first()).toContainText("Uncommitted Changes");
}

test("compares any two commits in chronological order and exits comparison (#512)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const newer = view.locator(".commit-row").nth(2);
  const older = view.locator(".commit-row").nth(6);
  const newerOid = await newer.getAttribute("data-oid");
  const olderOid = await older.getAttribute("data-oid");

  await newer.click();
  const detail = page.locator('[data-testid="git-graph-detail"]');
  await detail.getByRole("button", { name: "Compare this commit" }).click();
  await expect(detail).toContainText("Select another commit to compare");
  await older.click();
  await expect(detail).toContainText(`Comparing ${olderOid} → ${newerOid}`);
  await expect(detail.locator(".detail-file", { hasText: "src/compared.ts" })).toBeVisible();

  await detail.locator(".detail-file", { hasText: "src/compared.ts" }).click();
  const diff = page.locator('[data-testid="git-graph-file-diff"]');
  await expect(diff).toContainText(`older ${olderOid}`);
  await expect(diff).toContainText(`newer ${newerOid}`);
  await page.screenshot({ path: "evidence/ac-1-any-two-commits-compared.png" });
  await detail.getByRole("button", { name: "Exit comparison" }).click();
  await expect(detail).toContainText("Merge hotfix into main");
  await expect(detail).not.toContainText("Comparing");
});

test("routes a commit comparison file through the preview diff (#512)", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const raw = localStorage.getItem("explorer-settings");
    const settings = raw ? JSON.parse(raw) : {};
    settings.showPreviewPane = true;
    localStorage.setItem("explorer-settings", JSON.stringify(settings));
  });
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const newer = view.locator(".commit-row").nth(2);
  const older = view.locator(".commit-row").nth(6);
  const newerOid = await newer.getAttribute("data-oid");
  const olderOid = await older.getAttribute("data-oid");
  await newer.click();
  await page.getByRole("button", { name: "Compare this commit" }).click();
  await older.click();
  await page.locator(".detail-file", { hasText: "src/compared.ts" }).click();

  const preview = page.locator(".preview-pane");
  await expect(preview).toContainText(`compare ${olderOid} → ${newerOid}`);
  await expect(preview).toContainText(`older ${olderOid}`);
  await expect(preview).toContainText(`newer ${newerOid}`);
});
