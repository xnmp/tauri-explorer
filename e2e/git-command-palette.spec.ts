/** Command-palette Git targets (#520). */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraph(page: Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="git-graph-view"]')).toBeVisible();
}

test("fuzzy palette exposes Git actions and branch checkout targets", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraph(page);

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Git:");

  const palette = page.locator(".command-palette-dialog");
  await expect(palette.getByText("Git: Checkout Branch feature", { exact: true })).toBeVisible();
  await expect(palette.getByText("Git: Merge Branch feature", { exact: true })).toBeVisible();
  await expect(palette.getByText(/Git: Cherry-pick 0010001/)).toBeVisible();
  await expect(palette.getByText(/Git: Rebase onto 0010001/)).toBeVisible();
  await expect(palette.getByText("Git: Apply Stash stash@{0}", { exact: true })).toBeVisible();
  await expect(palette.getByText("Git: Pop Stash stash@{0}", { exact: true })).toBeVisible();
  await page.screenshot({ path: "evidence/ac-1-git-actions.png" });

  await page.locator("input:focus").fill("Checkout Branch feature");
  await page.screenshot({ path: "evidence/ac-2-branch-checkout.png" });
  await page.keyboard.press("Enter");
  await expect(page.locator(".commit-row .ref-branch.ref-active")).toHaveText("feature");

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("0010001");
  const jump = palette.getByText("Git: Jump to Commit 0010001 — Merge hotfix into main", { exact: true });
  await expect(jump).toBeVisible();
  await page.screenshot({ path: "evidence/ac-3-commit-jump.png" });
  await jump.click();
  await expect(page.locator('.commit-row.selected[data-oid="0010001"]')).toBeVisible();

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Git:");
  await page.screenshot({ path: "evidence/ac-4-git-command-palette.png" });
});
