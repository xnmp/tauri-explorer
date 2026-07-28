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
  await page.screenshot({ path: "evidence/ac-1-undo-confirmation.png", animations: "disabled" });

  await undo.getByText("Cancel", { exact: true }).click();
  await expect(undo).toHaveCount(0);
  await expect(hotfixChip).toHaveCount(0);
  await page.screenshot({ path: "evidence/ac-3-cancel-keeps-deletion.png", animations: "disabled" });

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
  await page.screenshot({ path: "evidence/ac-2-branch-restored.png", animations: "disabled" });
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

test("a recreated ref makes the confirmed undo fail safely without moving it", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraph(page);
  const view = page.locator('[data-testid="git-graph-view"]');

  const experiment = view.locator(".ref-branch", { hasText: "experiment" });
  await experiment.click({ button: "right" });
  await page
    .locator('[data-testid="git-graph-menu"]')
    .getByText("Delete Branch 'experiment'…")
    .click();
  await page
    .locator('[data-testid="git-graph-action-modal"]')
    .getByText("Delete", { exact: true })
    .click();
  await expect(experiment).toHaveCount(0);

  const initial = view.locator(".commit-row").filter({ hasText: "Initial commit" });
  const recreatedOid = await initial.getAttribute("data-oid");
  await initial.click({ button: "right" });
  await page.locator('[data-testid="git-graph-menu"]').getByText("Create Branch…").click();
  const create = page.locator('[data-testid="git-graph-prompt"]');
  await create.locator("input").fill("experiment");
  await create.getByText("Create branch", { exact: true }).click();
  await expect(initial.locator(".ref-branch", { hasText: "experiment" })).toBeVisible();
  await expect(page.locator(".toast", { hasText: "Create branch done" })).toHaveCount(0);

  await page.keyboard.press("Control+z");
  await page
    .locator('[data-testid="git-graph-undo-modal"]')
    .getByText("Undo", { exact: true })
    .click();
  await expect(page.locator(".toast", { hasText: "already exists" })).toBeVisible();
  await expect(
    view.locator(".commit-row").filter({
      has: page.locator(".ref-branch", { hasText: "experiment" }),
    }),
  ).toHaveAttribute("data-oid", recreatedOid!);
  await page.screenshot({ path: "evidence/ac-4-stale-ref-refused.png", animations: "disabled" });
});

test("Ctrl+Z outside the graph retains file-operation undo", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  const file = page.locator(".entry-item:not(.directory)").first();
  const originalName = await file.locator(".entry-name").innerText();
  await file.click();
  await page.keyboard.press("F2");
  const input = page.locator(".rename-input");
  await input.fill("undo-routing.txt");
  await page.keyboard.press("Enter");
  await expect(page.locator(".entry-name", { hasText: "undo-routing.txt" })).toBeVisible();

  await page.locator(".explorer-pane").focus();
  await page.keyboard.press("Control+z");
  await expect(page.locator(".entry-name", { hasText: originalName })).toBeVisible();
  await expect(page.locator(".toast", { hasText: "Undo: Rename" })).toBeVisible();
  await page.screenshot({ path: "evidence/ac-5-file-undo-outside-graph.png", animations: "disabled" });
});
