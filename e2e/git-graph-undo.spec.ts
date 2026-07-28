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

test("tag delete and branch rename join the same confirmed undo history", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraph(page);
  const view = page.locator('[data-testid="git-graph-view"]');

  const tag = view.locator(".ref-tag", { hasText: "v1.0" });
  await tag.click({ button: "right" });
  await page.locator('[data-testid="git-graph-menu"]').getByText("Delete Tag 'v1.0'…").click();
  await page
    .locator('[data-testid="git-graph-action-modal"]')
    .getByText("Delete", { exact: true })
    .click();
  await expect(tag).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-testid="git-graph-undo-modal"]')).toContainText(
    "delete tag 'v1.0'",
  );
  await page
    .locator('[data-testid="git-graph-undo-modal"]')
    .getByText("Undo", { exact: true })
    .click();
  await expect(tag).toBeVisible();

  const hotfix = view
    .locator(".ref-branch")
    .filter({ hasText: "hotfix", hasNotText: "hotfix-renamed" })
    .first();
  await hotfix.click({ button: "right" });
  await page
    .locator('[data-testid="git-graph-menu"]')
    .getByText("Rename Branch 'hotfix'…")
    .click();
  const rename = page.locator('[data-testid="git-graph-rename-prompt"]');
  await rename.locator("input").fill("hotfix-renamed");
  await rename.getByText("Rename", { exact: true }).click();
  await expect(view.locator(".ref-branch", { hasText: "hotfix-renamed" })).toBeVisible();
  await expect(hotfix).toHaveCount(0);

  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-testid="git-graph-undo-modal"]')).toContainText(
    "rename branch 'hotfix' to 'hotfix-renamed'",
  );
  await page
    .locator('[data-testid="git-graph-undo-modal"]')
    .getByText("Undo", { exact: true })
    .click();
  await expect(hotfix).toBeVisible();
  await expect(view.locator(".ref-branch", { hasText: "hotfix-renamed" })).toHaveCount(0);
});

test("merge and pull undo restore the prior checked-out tip", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraph(page);
  const view = page.locator('[data-testid="git-graph-view"]');
  const originalHead = view.locator(".commit-row").filter({ hasText: "Merge hotfix into main" });
  await expect(originalHead).toHaveClass(/is-head/);

  await view
    .locator(".commit-row")
    .filter({ hasText: "Add tests for feature X" })
    .click({ button: "right" });
  await page.locator('[data-testid="git-graph-menu"]').getByText("Merge into current branch").click();
  await expect(view.locator(".commit-row").nth(1)).toContainText("Merge feature into current branch");
  await page.keyboard.press("Control+z");
  await page
    .locator('[data-testid="git-graph-undo-modal"]')
    .getByText("Undo", { exact: true })
    .click();
  await expect(originalHead).toHaveClass(/is-head/);

  const hotfix = view.locator(".ref-branch", { hasText: "hotfix" }).first();
  await hotfix.click({ button: "right" });
  await page.locator('[data-testid="git-graph-menu"]').getByText("Checkout hotfix").click();
  const offer = page.locator('[data-testid="git-graph-pull-offer"]');
  await expect(offer).toBeVisible();
  await offer.getByText("Pull", { exact: true }).click();
  await expect(view.locator(".commit-row").nth(1)).toContainText("Pull from upstream");
  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-testid="git-graph-undo-modal"]')).toContainText(
    "pull into 'hotfix'",
  );
  await page
    .locator('[data-testid="git-graph-undo-modal"]')
    .getByText("Undo", { exact: true })
    .click();
  await expect(
    view.locator(".commit-row").filter({ has: page.locator(".ref-branch.ref-active", { hasText: "hotfix" }) }),
  ).toHaveAttribute("data-oid", "000d000");
});
