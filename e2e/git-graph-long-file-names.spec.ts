/**
 * Long file names in the git graph's changed-files list must stay on one line
 * (#500).
 *
 * The bug: `.file-path` declared `word-break: break-all` with nothing stopping
 * it wrapping, so a long path reflowed *mid-word* — 2 lines at a 1280px window
 * and 6 lines at 700px — inflating the inline commit panel and shoving the
 * graph rows beneath it down. Every other column in the graph (commit message,
 * author) truncates with an ellipsis instead.
 *
 * The only layer that produces the observable ("how tall is the row and does it
 * fit?") is the rendered document after layout has run, so every assertion here
 * is DOM geometry read from a real browser rather than an inspection of the CSS
 * source. Screenshots are captured as a side effect of the assertions, so the
 * image and the assertion cannot drift apart.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

/**
 * Mirrors `MOCK_LONG_COMMIT_FILE_PATH` in src/lib/api/mock-invoke.ts, the file
 * list served for the "Update README with usage" commit. Written out literally
 * rather than imported so this spec does not pull the mock backend (and its
 * browser-only globals) into the Playwright node process.
 */
const LONG_PATH =
  "src/lib/components/experimental/deeply/nested/generated/" +
  "AnExtremelyLongGeneratedComponentFileNameThatOverflowsThePanel.svelte";

/** Commit whose changed-files list is the long path above. */
const LONG_PATH_COMMIT = "Update README with usage";
/** Commit whose changed-files list is a short path, used as the baseline. */
const SHORT_PATH_COMMIT = "Add tests for feature X";

/**
 * PNGs aren't byte-reproducible, so writing straight to the committed
 * `evidence/` copy would dirty the tree on every ordinary e2e run. Default to
 * gitignored test-results/; refresh the committed evidence with
 * CAPTURE_EVIDENCE=1. (Same convention as git-graph-changed-files-font.spec.ts.)
 */
const shotPath = (name: string) =>
  process.env.CAPTURE_EVIDENCE ? `evidence/${name}` : `test-results/${name}`;

async function openGraph(page: Page) {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(
    page.locator('[data-testid="git-graph-view"] .commit-row').first(),
  ).toContainText("Uncommitted Changes");
}

/**
 * Select `summary`'s commit row and return the geometry of its single
 * changed-file row plus the enclosing panel. Waits on the file list actually
 * having rendered so nothing here measures an empty or still-loading panel.
 */
async function measureFileRow(page: Page, summary: string) {
  const view = page.locator('[data-testid="git-graph-view"]');
  await view.locator(".commit-row", { hasText: summary }).first().click();

  const filePath = view.locator(".file-path").first();
  await expect(filePath).toBeVisible();
  await expect(filePath).not.toBeEmpty();

  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="git-graph-view"]');
    if (!root) throw new Error("no git graph view");
    const q = (sel: string) => {
      const el = root.querySelector(sel);
      if (!el) throw new Error(`no element for ${sel}`);
      return el;
    };
    const row = q(".detail-file");
    const path = q(".file-path");
    const col = q(".detail-files-col");
    const panel = q(".commit-detail-inline");
    return {
      rowHeight: row.getBoundingClientRect().height,
      pathHeight: path.getBoundingClientRect().height,
      pathRight: path.getBoundingClientRect().right,
      colRight: col.getBoundingClientRect().right,
      colWidth: col.getBoundingClientRect().width,
      panelHeight: panel.getBoundingClientRect().height,
      text: path.textContent,
    };
  });
}

/** Close the open commit detail so the next selection measures cleanly. */
async function closeDetail(page: Page) {
  const panel = page.locator('[data-testid="git-graph-view"] .commit-detail-inline');
  await panel.locator(".detail-close").first().click();
  await expect(panel).toHaveCount(0);
}

test.describe("Git graph long file names (#500)", () => {
  test("AC 1: at 1280px a long path is one line tall and stays inside the column", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openGraph(page);

    const short = await measureFileRow(page, SHORT_PATH_COMMIT);
    await closeDetail(page);
    const long = await measureFileRow(page, LONG_PATH_COMMIT);

    // Guard: the baseline really is short and the subject really is long, so
    // the height comparison below is not comparing two similar strings.
    expect(short.text?.length ?? 0).toBeLessThan(30);
    expect(long.text).toBe(LONG_PATH);

    // The observable: row height no longer grows with path length. Before the
    // fix this row was two wrapped lines, i.e. ~2x the short row.
    expect(long.rowHeight).toBeCloseTo(short.rowHeight, 1);
    expect(long.pathHeight).toBeCloseTo(short.pathHeight, 1);

    // ...and it does not achieve that by spilling out sideways.
    expect(long.pathRight).toBeLessThanOrEqual(long.colRight + 0.5);

    // Full page rather than an element crop: the criterion is about the row
    // not growing, which is only judgeable next to the graph rows it used to
    // displace.
    await page.screenshot({ path: shotPath("ac-1-long-path-one-line-1280.png") });
  });

  test("AC 2: at 700px it is still one line and the panel does not grow", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await openGraph(page);

    const short = await measureFileRow(page, SHORT_PATH_COMMIT);
    await closeDetail(page);
    const long = await measureFileRow(page, LONG_PATH_COMMIT);

    // 700px is where the bug was worst: the changed-files column narrows to
    // ~190px and the path reflowed into six mid-word lines.
    expect(long.colWidth).toBeLessThan(260);
    expect(long.text).toBe(LONG_PATH);

    expect(long.rowHeight).toBeCloseTo(short.rowHeight, 1);
    expect(long.pathRight).toBeLessThanOrEqual(long.colRight + 0.5);

    // The user-visible consequence of the wrap was a taller commit panel
    // displacing the graph below it; the panel is now path-length independent.
    expect(long.panelHeight).toBeCloseTo(short.panelHeight, 1);

    await page.screenshot({ path: shotPath("ac-2-long-path-one-line-700.png") });
  });

  test("AC 3: the base name is kept whole and the directory prefix is what elides", async ({
    page,
  }) => {
    // 1280px, where the base name (~520px) fits the ~588px column but the
    // whole path (~913px) does not — so the directory prefix must give up all
    // of the deficit and none of it may come out of the name. A proportional
    // flex-shrink split fails here by ~2px, which is exactly the bug this
    // width catches. The case where the name itself cannot fit and must
    // ellipsise is AC 2's job at 700px.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openGraph(page);
    await measureFileRow(page, LONG_PATH_COMMIT);

    const parts = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="git-graph-view"]');
      if (!root) throw new Error("no git graph view");
      const pick = (sel: string) => {
        const el = root.querySelector(sel);
        if (!el) throw new Error(`no element for ${sel}`);
        return {
          text: el.textContent ?? "",
          truncated: el.scrollWidth > el.clientWidth + 0.5,
        };
      };
      const path = root.querySelector(".file-path");
      return {
        dir: pick(".file-dir"),
        name: pick(".file-name"),
        pathText: path?.textContent ?? "",
        title: path?.getAttribute("title") ?? null,
      };
    });

    // The identifying half is rendered in full...
    expect(parts.name.text).toBe(
      "AnExtremelyLongGeneratedComponentFileNameThatOverflowsThePanel.svelte",
    );
    expect(parts.name.truncated).toBe(false);
    // ...and the directory prefix is the half that gives up space.
    expect(parts.dir.text).toBe("src/lib/components/experimental/deeply/nested/generated/");
    expect(parts.dir.truncated).toBe(true);

    // Splitting the path in two must not change the path: the row still reads
    // as the complete path (which is what other specs match on), and the full
    // path is recoverable on hover even though part of it is elided.
    expect(parts.pathText).toBe(LONG_PATH);
    expect(parts.title).toBe(LONG_PATH);

    await page
      .locator('[data-testid="git-graph-view"] .detail-files-col')
      .first()
      .screenshot({ path: shotPath("ac-3-basename-kept-dir-elided.png") });
  });
});
