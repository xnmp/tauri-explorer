/**
 * E2E: background-operation progress + cancellation (#296).
 *
 * The "jobs panel" in this codebase is two things:
 *  - `JobsPanel.svelte` / `jobs.svelte.ts` — plugin AI jobs (nano-banana,
 *    upscale). These have no numeric progress and no cancel affordance, and
 *    they can only be driven to completion by a backend event that needs a
 *    real API key, so they are not observable end-to-end in the browser mock.
 *  - `ProgressDialog.svelte` / `operations.svelte.ts` — the genuine
 *    progress-with-cancellation surface for file operations (copy/move). It
 *    shows a per-operation row with an advancing progress bar, a "Complete"
 *    state, and a Cancel button. This is the feature that actually satisfies
 *    "a long operation makes a row appear with progress that advances and
 *    completes; cancelling stops it", so it is what these tests exercise.
 *
 * No mock addition is needed: a multi-file paste drives real progress updates
 * (the paste loop calls `updateProgress` per file), and the existing per-command
 * latency injection (`?mockLatency=copy_entry:MS`) keeps the operation running
 * long enough (past the 1.5s dialog-delay gate) for the dialog to appear.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries, pressShortcut, MULTI_SELECT_MODIFIER } from "./helpers";

/** Select the three Documents files that don't exist in Pictures. */
async function selectThreeDocs(page: Page) {
  const names = ["report.pdf", "budget.xlsx", "presentation.pptx"];
  const first = page.locator(".entry-item", { hasText: names[0] }).first();
  await first.click();
  await expect(first).toHaveClass(/selected/);
  for (const n of names.slice(1)) {
    await page
      .locator(".entry-item", { hasText: n })
      .first()
      .click({ modifiers: [MULTI_SELECT_MODIFIER] });
  }
  await expect(page.locator(".entry-item.selected")).toHaveCount(3);
}

async function gotoPictures(page: Page) {
  // From /home/user/Documents, go up to /home/user, then into Pictures
  // (a sibling of Documents). Navigate within the SPA so the in-memory
  // clipboard survives (a full reload would clear it).
  await page.keyboard.press("Control+Alt+ArrowUp");
  await expect(page.locator(".breadcrumbs-container")).not.toContainText("Documents");
  await waitForEntries(page);
  const pics = page.locator(".entry-item", { hasText: "Pictures" }).first();
  await pics.dblclick();
  await expect(page.locator(".breadcrumbs-container")).toContainText("Pictures");
  await waitForEntries(page);
}

test.describe("File-operation progress dialog", () => {
  test("a slow multi-file copy shows a progress row that advances and completes", async ({
    page,
  }) => {
    // ~1s per file × 3 files = ~3s, comfortably past the 1.5s dialog gate.
    await page.goto("/?path=/home/user/Documents&mockLatency=copy_entry:1000");
    await waitForEntries(page);

    await selectThreeDocs(page);
    await pressShortcut(page, "c", { ctrlKey: true });
    await expect(page.locator(".toast.clipboard")).toBeVisible();

    await gotoPictures(page);
    await pressShortcut(page, "v", { ctrlKey: true });

    // Progress dialog appears with a running "Copying" operation.
    const dialog = page.locator(".progress-dialog");
    await expect(dialog).toBeVisible({ timeout: 4000 });
    await expect(dialog.locator(".dialog-title")).toHaveText("File Operations");
    await expect(dialog.locator(".operation-item .operation-type").first()).toHaveText(
      "Copying",
    );
    // A running operation renders its progress bar + percentage.
    await expect(dialog.locator(".progress-bar").first()).toBeVisible();

    // The operation transitions to "Complete" (progress reached 100%).
    await expect(dialog.locator(".status-text.success").first()).toHaveText("Complete", {
      timeout: 8000,
    });

    // Outcome: all three files were actually copied into Pictures.
    await expect
      .poll(() => page.locator(".entry-item .entry-name").allTextContents(), {
        timeout: 5000,
      })
      .toEqual(expect.arrayContaining(["report.pdf", "budget.xlsx", "presentation.pptx"]));
  });

  test("cancelling a running copy stops it before the remaining files are copied", async ({
    page,
  }) => {
    // 2s per file: at the 1.5s dialog gate the first file is still copying, so
    // cancelling then guarantees files #2 and #3 never start.
    await page.goto("/?path=/home/user/Documents&mockLatency=copy_entry:2000");
    await waitForEntries(page);

    await selectThreeDocs(page);
    await pressShortcut(page, "c", { ctrlKey: true });
    await expect(page.locator(".toast.clipboard")).toBeVisible();

    await gotoPictures(page);
    await pressShortcut(page, "v", { ctrlKey: true });

    const dialog = page.locator(".progress-dialog");
    await expect(dialog).toBeVisible({ timeout: 4000 });
    const cancelBtn = dialog.locator(".operation-item .action-btn.cancel").first();
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();

    // Cancellation removes the running operation and dismisses the dialog.
    await expect(dialog).toBeHidden({ timeout: 4000 });
    // It never reports completion.
    await expect(page.locator(".status-text.success")).toHaveCount(0);

    // Outcome: the batch was interrupted — not all three files were copied.
    // (Cancellation breaks the paste loop, so at least the last queued file
    // never lands.) Give any cancelled in-flight copy time to settle first.
    await page.waitForTimeout(2500);
    const names = await page.locator(".entry-item .entry-name").allTextContents();
    const copied = ["report.pdf", "budget.xlsx", "presentation.pptx"].filter((n) =>
      names.includes(n),
    );
    expect(copied.length).toBeLessThan(3);
  });
});
