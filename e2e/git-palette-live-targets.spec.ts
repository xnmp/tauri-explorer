/**
 * An open command palette follows late Git target registration (#1236).
 *
 * The palette is opened before Git history finishes loading and its query is
 * never edited: the dynamic Checkout/Merge/commit/stash targets must appear
 * in place and execute against the loaded graph.
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

test("open palette with an unchanged Git: query gains late history targets", async ({
  page,
}) => {
  await page.addInitScript(() => {
    ((window as unknown as { __mockControl?: MockControl }).__mockControl ??= {}).latency = {
      git_log: 1200,
    };
  });
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  const graph = page.locator('[data-testid="git-graph-view"]');
  await expect(graph).toBeVisible();

  // Open before history arrives: only static Git actions can match yet.
  await page.keyboard.press("Control+Shift+p");
  const input = page.locator(".command-palette-dialog input");
  await input.fill("Git:");
  const palette = page.locator(".command-palette-dialog");
  const checkout = palette.getByText("Git: Checkout Branch feature", { exact: true });
  await expect(checkout).toHaveCount(0);

  // Highlight a static action that sits below where the branch targets will
  // be inserted; the late rows must not move the highlight to another command.
  const selected = palette.locator(".command-item.selected .command-label");
  const refresh = "Git Graph: Refresh (fetch from remotes)";
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await expect(selected).toHaveText(refresh);

  // History loads while the query stays exactly "Git:".
  await expect(checkout).toBeVisible();
  await expect(selected).toHaveText(refresh);
  await expect(palette.getByText("Git: Merge Branch feature", { exact: true })).toBeVisible();
  await expect(palette.getByText(/Git: Cherry-pick 0010001/)).toBeVisible();
  await expect(palette.getByText(/Git: Apply Stash stash@\{0\}/)).toBeVisible();
  await expect(input).toHaveValue("Git:");
  await page.screenshot({
    path: "screenshots/fix/git-palette-live-targets/palette-live-targets.png",
  });

  // The late target executes against the loaded graph.
  await checkout.click();
  await expect(palette).toHaveCount(0);
  await expect(page.locator(".commit-row .ref-branch.ref-active")).toHaveText("feature");
});
