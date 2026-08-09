import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraph(page: import("@playwright/test").Page): Promise<void> {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  const graph = page.locator('[data-testid="git-graph-view"]');
  await expect(graph).toBeVisible();
  await expect(graph.locator(".commit-row").first()).toContainText("Uncommitted Changes");
}

async function cancelOperation(
  page: import("@playwright/test").Page,
  ariaLabel: string,
): Promise<void> {
  const graph = page.locator('[data-testid="git-graph-view"]');
  const cancel = graph.getByRole("button", { name: ariaLabel });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(page.locator(".toast", { hasText: /git network operation cancelled/i })).toBeVisible();
  await expect(cancel).toHaveCount(0);
  await expect(graph.locator(".commit-row").first()).toContainText("Uncommitted Changes");
}

test("a cancelled graph fetch skips local sync and leaves the graph usable", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project&mockGitNetwork=git_fetch");
  await waitForEntries(page);

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("F5 Syncs Local Branches");
  await page.keyboard.press("Enter");
  await openGraph(page);

  await page.keyboard.press("F5");
  const graph = page.locator('[data-testid="git-graph-view"]');
  const cancel = graph.getByRole("button", { name: "Cancel fetch" });
  await expect(cancel).toBeVisible();
  await page.screenshot({
    path: "evidence/ac-1-network-operation-running.png",
    animations: "disabled",
  });
  await cancel.click();

  await expect(page.locator(".toast", { hasText: "Git fetch cancelled" })).toBeVisible();
  await expect(cancel).toHaveCount(0);
  await expect(graph.locator(".commit-row").first()).toContainText("Uncommitted Changes");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __mockInvokeCounts?: Record<string, number> })
          .__mockInvokeCounts?.git_sync_local_branches ?? 0,
      ),
    )
    .toBe(0);
  await page.screenshot({
    path: "evidence/ac-1-network-operation-cancelled.png",
    animations: "disabled",
  });

  await page.keyboard.press("F5");
  await expect(graph.getByRole("button", { name: "Cancel fetch" })).toBeVisible();
});

test("a running pull exposes Cancel and restores the graph after cancellation", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project&mockGitNetwork=git_pull");
  await waitForEntries(page);
  await openGraph(page);

  const graph = page.locator('[data-testid="git-graph-view"]');
  await graph.locator(".ref-branch", { hasText: "hotfix" }).first().click({ button: "right" });
  await page.locator('[data-testid="git-graph-menu"]').getByText("Checkout hotfix").click();
  const offer = page.locator('[data-testid="git-graph-pull-offer"]');
  await expect(offer).toBeVisible();
  await offer.getByText("Pull", { exact: true }).click();

  await cancelOperation(page, "Cancel pull");
});

test("pull removes Cancel when the fast-forward phase is delivered", async ({ page }) => {
  await page.goto(
    "/?path=/home/user/Documents/project&mockGitNetwork=git_pull&mockGitPullBoundary=fast_forward",
  );
  await waitForEntries(page);
  await openGraph(page);

  const graph = page.locator('[data-testid="git-graph-view"]');
  await graph.locator(".ref-branch", { hasText: "hotfix" }).first().click({ button: "right" });
  await page.locator('[data-testid="git-graph-menu"]').getByText("Checkout hotfix").click();
  const offer = page.locator('[data-testid="git-graph-pull-offer"]');
  await expect(offer).toBeVisible();
  await offer.getByText("Pull", { exact: true }).click();

  const banner = graph.locator(".network-operation-banner");
  await expect(banner).toContainText("Finishing Git pull…");
  await expect(graph.getByRole("button", { name: "Cancel pull" })).toHaveCount(0);

  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("tauri-explorer:mock-git-pull-finish")),
  );
  await expect(page.locator(".toast", { hasText: "Pull done" })).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test("a late pull cancellation reports finishing and preserves undo", async ({ page }) => {
  await page.goto(
    "/?path=/home/user/Documents/project&mockGitNetwork=git_pull&mockGitPullBoundary=late_cancel",
  );
  await waitForEntries(page);
  await openGraph(page);

  const graph = page.locator('[data-testid="git-graph-view"]');
  await graph.locator(".ref-branch", { hasText: "hotfix" }).first().click({ button: "right" });
  await page.locator('[data-testid="git-graph-menu"]').getByText("Checkout hotfix").click();
  const offer = page.locator('[data-testid="git-graph-pull-offer"]');
  await expect(offer).toBeVisible();
  await offer.getByText("Pull", { exact: true }).click();

  const banner = graph.locator(".network-operation-banner");
  const cancel = graph.getByRole("button", { name: "Cancel pull" });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(banner).toContainText("Finishing Git pull…");
  await expect(cancel).toHaveCount(0);
  await page.screenshot({
    path: "evidence/ac-2-pull-finishing-without-cancel.png",
    animations: "disabled",
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __mockInvokeCounts?: Record<string, number> })
          .__mockInvokeCounts?.cancel_git_network_operation ?? 0,
      ),
    )
    .toBe(1);
  await expect(page.locator(".toast", { hasText: /cancelled/i })).toHaveCount(0);

  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("tauri-explorer:mock-git-pull-finish")),
  );
  await expect(page.locator(".toast", { hasText: "Pull done" })).toBeVisible();
  await expect(banner).toHaveCount(0);

  await page.keyboard.press("Control+z");
  const undo = page.locator('[data-testid="git-graph-undo-modal"]');
  await expect(undo).toBeVisible();
  await expect(undo).toContainText("pull into 'hotfix'");
  await undo.getByText("Cancel", { exact: true }).click();
});

test("a remote-only branch push exposes Cancel and restores the graph", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project&mockGitNetwork=git_delete_remote_branch");
  await waitForEntries(page);
  await openGraph(page);

  const graph = page.locator('[data-testid="git-graph-view"]');
  const remote = graph.locator(".ref-remote", { hasText: "origin/legacy-import" });
  await remote.click({ button: "right" });
  await page
    .locator('[data-testid="git-graph-menu"]')
    .getByText("Delete Remote Branch 'origin/legacy-import'")
    .click();

  await cancelOperation(page, "Cancel push to origin");
  await expect(remote).toBeVisible();
});

test("delete plus remote exposes Cancel for its push and keeps the graph usable", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project&mockGitNetwork=git_delete_remote_branch");
  await waitForEntries(page);
  await openGraph(page);

  const graph = page.locator('[data-testid="git-graph-view"]');
  const hotfix = graph.locator(".ref-branch", { hasText: "hotfix" }).first();
  await hotfix.click({ button: "right" });
  await page.locator('[data-testid="git-graph-menu"]').getByText("Delete Branch 'hotfix'…").click();
  await page
    .locator('[data-testid="git-graph-action-modal"]')
    .getByText("Delete + remote", { exact: true })
    .click();

  await cancelOperation(page, "Cancel push to origin");
  await expect(hotfix).toHaveCount(0);
});
