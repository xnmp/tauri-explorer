import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraph(page: import("@playwright/test").Page): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(
    page.locator('[data-testid="git-graph-view"] .commit-row').first(),
  ).toContainText("Uncommitted Changes");
}

test("Ctrl+Z confirms and visibly restores a deleted branch at its original commit", async ({
  page,
}) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraph(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const hotfixChip = view.locator(".ref-branch", { hasText: "hotfix" }).first();
  const originalRow = view
    .locator(".commit-row")
    .filter({ has: page.locator(".ref-branch", { hasText: "hotfix" }) })
    .first();
  const originalOid = await originalRow.getAttribute("data-oid");

  await hotfixChip.click({ button: "right" });
  await page
    .locator('[data-testid="git-graph-menu"]')
    .getByText("Delete Branch 'hotfix'…")
    .click();
  await page
    .locator('[data-testid="git-graph-action-modal"]')
    .getByText("Delete", { exact: true })
    .click();
  await expect(hotfixChip).toHaveCount(0);

  await page.keyboard.press("Control+z");
  const undo = page.locator('[data-testid="git-graph-undo-modal"]');
  await expect(undo).toBeVisible();
  await expect(undo).toContainText("delete branch 'hotfix'");
  await expect(undo).toContainText(originalOid!.slice(0, 7));

  await undo.getByText("Cancel", { exact: true }).click();
  await expect(undo).toHaveCount(0);
  await expect(hotfixChip).toHaveCount(0);

  await page.keyboard.press("Control+z");
  await page
    .locator('[data-testid="git-graph-undo-modal"]')
    .getByText("Undo", { exact: true })
    .click();

  const restoredRow = view
    .locator(".commit-row")
    .filter({ has: page.locator(".ref-branch", { hasText: "hotfix" }) })
    .first();
  await expect(restoredRow).toHaveAttribute("data-oid", originalOid!);
  await expect(page.locator(".toast", { hasText: "Undo: delete branch 'hotfix'" })).toBeVisible();
});
