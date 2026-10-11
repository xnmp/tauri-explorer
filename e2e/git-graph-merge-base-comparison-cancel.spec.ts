import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

async function selectOriginalCommit(page: Page) {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.locator(".commit-row").first()).toContainText("Uncommitted Changes");
  await page.locator(".commit-row", { hasText: "Update README with usage" }).click();
  await expect(page.locator(".commit-row.selected")).toHaveAttribute("data-oid", "000b000");
}

async function delayAncestorLookup(page: Page) {
  await page.getByRole("button", { name: "Filter branches", exact: true }).click();
  await page.getByLabel("First merge-base branch").selectOption("refs/heads/experiment");
  await page.getByLabel("Second merge-base branch").selectOption("refs/heads/feature");
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => {
    ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {}).latency = { git_merge_base: 10_000 };
  });
  await page.getByRole("button", { name: "Jump to merge-base", exact: true }).click();
  await page.clock.runFor(50);
  await expect(page.getByRole("button", { name: "Finding merge-base…" })).toBeDisabled();
  await page.getByRole("button", { name: "Close branch filter", exact: true }).click();
}

async function expectOriginalDetails(page: Page) {
  await expect(page.locator(".commit-row.selected")).toHaveAttribute("data-oid", "000b000");
  await expect(page.locator('[data-testid="git-graph-detail"]')).toContainText("Update README with usage");
  await expect(page.locator(".gh-message")).toHaveText("Message");
}

test("begin comparison preserves the selected commit and prompt after a delayed fork-point lookup", async ({ page }) => {
  await selectOriginalCommit(page);
  await delayAncestorLookup(page);
  await page.getByRole("button", { name: "Compare this commit", exact: true }).click();
  const prompt = page.locator(".compare-status");
  await expect(prompt).toHaveText("Select another commit to compare with 000b000.");
  await page.clock.runFor(11_000);
  await expect(page.locator(".commit-row.selected")).toHaveAttribute("data-oid", "000b000");
  await expect(prompt).toHaveText("Select another commit to compare with 000b000.");
  await expect(page.locator(".gh-message")).toHaveText("Message");
  await page.mouse.move(1100, 670);
  await page.screenshot({ path: "evidence/ac-3-comparison-interruption.png" });
});

test("cancel comparison preserves ordinary commit details after a delayed fork-point lookup", async ({ page }) => {
  await selectOriginalCommit(page);
  await page.getByRole("button", { name: "Compare this commit", exact: true }).click();
  await expect(page.locator(".compare-status")).toContainText("Select another commit");
  await delayAncestorLookup(page);
  await page.getByRole("button", { name: "Cancel comparison", exact: true }).click();
  await page.clock.runFor(11_000);
  await expectOriginalDetails(page);
  await expect(page.locator(".compare-status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Compare this commit", exact: true })).toBeVisible();
});

test("exit comparison preserves ordinary commit details after a delayed fork-point lookup", async ({ page }) => {
  await selectOriginalCommit(page);
  await page.getByRole("button", { name: "Compare this commit", exact: true }).click();
  await page.locator('.commit-row[data-oid="000a000"]').click();
  await expect(page.locator(".compare-status")).toContainText("Comparing");
  await delayAncestorLookup(page);
  await page.getByRole("button", { name: "Exit comparison", exact: true }).click();
  await page.clock.runFor(11_000);
  await expect(page.locator(".commit-row.selected")).toHaveAttribute("data-oid", "000b000");
  await expect(page.locator('[data-testid="git-graph-detail"]')).toContainText("Update README with usage");
  await expect(page.locator(".compare-status")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Compare this commit", exact: true })).toBeVisible();
  await expect(page.locator(".gh-message")).toHaveText("Message");
});
