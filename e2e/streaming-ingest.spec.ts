/**
 * Streaming-ingest navigation correctness.
 * Issue: streaming-ingest-batching
 *
 * Guards the buffered-batch refactor in explorer.svelte.ts (navigateInternal):
 * streamed directory batches are now accumulated in a non-reactive buffer and
 * committed on a throttle + at done, instead of a per-batch reactive
 * `entries = [...entries, ...batch]`. This test asserts the user-visible
 * OUTCOME the refactor must preserve — every entry of a navigated directory
 * appears, in the correct order (directories first, then alphabetical) — so a
 * regression that drops, duplicates, or misorders entries fails here.
 *
 * Note: the browser mock (mock-invoke.ts) returns listings inline
 * (listing_id null), i.e. the non-streaming path; per-batch streaming cost is
 * covered by tests/perf/streaming-ingest.bench.ts. This spec covers the
 * navigation outcome end-to-end.
 */

import { test, expect, type Page } from "@playwright/test";

async function gotoDir(page: Page, path: string) {
  await page.goto(`/?path=${encodeURIComponent(path)}`);
  await page.waitForSelector(".file-list");
  await page.locator(".entry-item").first().waitFor({ timeout: 10000 });
}

test.describe("Streaming-ingest navigation correctness", () => {
  test("navigating a directory renders every entry, directories first then alphabetical", async ({
    page,
  }) => {
    await gotoDir(page, "/home/user");

    // /home/user mock fixture: 6 dirs (one hidden) + 2 files. Hidden files are
    // filtered by default, so .config should not appear.
    const names = await page.locator(".entry-item .entry-name").allInnerTexts();
    const trimmed = names.map((n) => n.trim()).filter(Boolean);

    // No hidden entry leaked through.
    expect(trimmed).not.toContain(".config");

    // Expected visible entries (dirs first, alphabetical; then files alphabetical).
    const expectedDirs = ["Archive", "Documents", "Downloads", "Music", "Pictures", "Videos"];
    const expectedFiles = ["notes.md", "readme.txt"];

    for (const name of [...expectedDirs, ...expectedFiles]) {
      expect(trimmed, `expected entry "${name}" to be present`).toContain(name);
    }

    // Ordering: each expected directory must appear before every expected file.
    const lastDirIdx = Math.max(...expectedDirs.map((d) => trimmed.indexOf(d)));
    const firstFileIdx = Math.min(...expectedFiles.map((f) => trimmed.indexOf(f)));
    expect(lastDirIdx).toBeLessThan(firstFileIdx);

    // Directories are in alphabetical order among themselves.
    const dirPositions = expectedDirs.map((d) => trimmed.indexOf(d));
    const sortedDirPositions = [...dirPositions].sort((a, b) => a - b);
    expect(dirPositions).toEqual(sortedDirPositions);
  });

  test("navigating between directories replaces entries with no leftovers", async ({ page }) => {
    await gotoDir(page, "/home/user");

    // Into Documents (has a distinctive file report.pdf, and no readme.txt).
    await page.locator('.entry-item.directory:has-text("Documents")').dblclick();
    await page.waitForFunction(
      () => !!document.querySelector('.entry-item .entry-name'),
      { timeout: 5000 },
    );
    await expect(page.locator('.entry-item:has-text("report.pdf")')).toHaveCount(1);

    // readme.txt belonged to the previous directory; it must not linger
    // (a buffer-seeding bug could carry stale entries across navigations).
    await expect(page.locator('.entry-item:has-text("readme.txt")')).toHaveCount(0);
  });
});
