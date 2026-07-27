/**
 * Branch-line jump shortcuts in the commit graph (#530).
 *
 * The observable seam: which row carries `.commit-row.selected` after a real
 * Ctrl+Up / Ctrl+Down keypress in a rendered graph. Screenshots are captured as
 * a side effect of the assertions so the committed evidence cannot drift from
 * what the test actually pinned.
 *
 * Mock topology (`MOCK_GRAPH_SPEC`): the tip's first-parent line runs
 * 0010001 → 000f000 → 000c000 → …, while 000e000 ("Try alternative parser") and
 * 000d000 ("Hotfix: crash on empty input") sit physically between 000f000 and
 * 000c000 on other branch lines.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

const MERGE_EXPERIMENT = "000f000"; // 15 — parents [12, 14]
const MERGE_FEATURE = "000c000"; // 12 — first parent of 15
const ALT_PARSER = "000e000"; // 14 — 15's SECOND parent, drawn between them
const HOTFIX = "000d000"; // 13 — on the hotfix line, drawn between them
const INITIAL_COMMIT = "0001000"; // 1 — root of the loaded page

async function openGraph(page: Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  // The synthetic uncommitted row lands with the async git summary and shifts
  // every row; anchor on it before addressing rows.
  await expect(
    page.locator('[data-testid="git-graph-view"] .commit-row').first(),
  ).toContainText("Uncommitted Changes");
}

/** The single selected row's oid — the value the shortcut actually moves. */
function selectedOid(page: Page) {
  return page.locator('[data-testid="git-graph-view"] .commit-row.selected');
}

async function selectRow(page: Page, oid: string) {
  const row = page.locator(`[data-testid="git-graph-view"] .commit-row[data-oid="${oid}"]`);
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(selectedOid(page)).toHaveAttribute("data-oid", oid);
}

test.describe("git graph branch-line jump (#530)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraph(page);
  });

  test("Ctrl+Down jumps to the first parent, skipping other branch lines", async ({ page }) => {
    await selectRow(page, MERGE_EXPERIMENT);

    await page.keyboard.press("Control+ArrowDown");

    const selected = selectedOid(page);
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute("data-oid", MERGE_FEATURE);
    // The two rows drawn between them belong to other lines and are stepped
    // over — they are on screen, but neither is selected.
    const view = page.locator('[data-testid="git-graph-view"]');
    await expect(view.locator(`.commit-row[data-oid="${ALT_PARSER}"]`)).toBeVisible();
    await expect(view.locator(`.commit-row[data-oid="${HOTFIX}"]`)).toBeVisible();
    await expect(view.locator(`.commit-row[data-oid="${ALT_PARSER}"]`)).not.toHaveClass(
      /selected/,
    );
    await expect(view.locator(`.commit-row[data-oid="${HOTFIX}"]`)).not.toHaveClass(/selected/);

    await page.screenshot({ path: "evidence/ac-1-ctrl-down-jump.png" });
  });

  test("Ctrl+Up jumps back up the same line", async ({ page }) => {
    await selectRow(page, MERGE_FEATURE);

    await page.keyboard.press("Control+ArrowUp");

    const selected = selectedOid(page);
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute("data-oid", MERGE_EXPERIMENT);

    await page.screenshot({ path: "evidence/ac-2-ctrl-up-jump.png" });
  });

  test("Ctrl+Down at the end of the line leaves the selection alone", async ({ page }) => {
    await selectRow(page, INITIAL_COMMIT);

    await page.keyboard.press("Control+ArrowDown");

    // No wrap-around, no jump to an unrelated row: the root commit's first
    // parent is not on the loaded page, so the selection stays put.
    const selected = selectedOid(page);
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveAttribute("data-oid", INITIAL_COMMIT);

    await page.screenshot({ path: "evidence/ac-3-root-noop.png" });
  });

  test("both jumps are palette commands while a graph pane is active", async ({ page }) => {
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Commit on Branch Line");

    const palette = page.locator(".command-palette-dialog");
    const older = palette.locator(".command-item", {
      hasText: "Git Graph: Select Older Commit on Branch Line",
    });
    const newer = palette.locator(".command-item", {
      hasText: "Git Graph: Select Newer Commit on Branch Line",
    });
    await expect(older).toHaveCount(1);
    await expect(newer).toHaveCount(1);
    // …each offered with the rebindable shortcut that runs it.
    await expect(older.locator(".command-shortcut")).toHaveText(/Ctrl\s*\+\s*↓/);
    await expect(newer.locator(".command-shortcut")).toHaveText(/Ctrl\s*\+\s*↑/);

    await page.screenshot({ path: "evidence/ac-4-palette-commands.png" });
  });
});
