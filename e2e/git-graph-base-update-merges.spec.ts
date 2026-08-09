import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraphViaPalette(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="git-graph-view"] .commit-row').first()).toContainText(
    "Uncommitted Changes",
  );
}

test("mutes only base-update merges and persists its independent preference (#527)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project&gitGraphBaseUpdateFixture=1");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const baseUpdate = view.locator(".commit-row", { hasText: "Merge hotfix into main" });
  const unrelated = view.locator(".commit-row", { hasText: "Merge experiment" });

  // Isolate #527 from the generic merge preference before asserting its
  // visible treatment.
  await page.locator(".graph-header").click({ button: "right" });
  await page.locator('[data-testid="toggle-mute-merges"]').click();
  await expect(baseUpdate).not.toHaveClass(/is-merge/);
  await expect(page.locator('[data-testid="toggle-mute-base-update-merges"]')).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(baseUpdate.locator(".summary")).toHaveCSS("opacity", "0.32");
  await expect(unrelated.locator(".summary")).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "evidence/ac-1-base-update-merges.png", fullPage: true });
  await page.screenshot({ path: "evidence/ac-2-unrelated-merge-emphasized.png", fullPage: true });

  await page.locator('[data-testid="toggle-mute-base-update-merges"]').click();
  await expect(baseUpdate.locator(".summary")).toHaveCSS("opacity", "1");

  // A full reload constructs fresh component state; the disabled preference
  // must be restored from persisted storage.
  await page.reload();
  await waitForEntries(page);
  await openGraphViaPalette(page);
  await page.locator(".graph-header").click({ button: "right" });
  await expect(page.locator('[data-testid="toggle-mute-base-update-merges"]')).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(
    view.locator(".commit-row", { hasText: "Merge hotfix into main" }).locator(".summary"),
  ).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "evidence/ac-3-muted-setting-persisted-off.png", fullPage: true });
});
