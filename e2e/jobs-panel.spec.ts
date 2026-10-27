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
 * latency injection (`?mockLatency=copy_entries:MS`) keeps the operation running
 * long enough (past the 1.5s dialog-delay gate) for the dialog to appear.
 */
import { test, expect, type Page } from "./fixtures";
import { activeExplorerPane, waitForEntries, pressShortcut, MULTI_SELECT_MODIFIER } from "./helpers";

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
  for (const [width, height] of [[1280, 600], [371, 600], [371, 300]]) {
    test(`a slow multi-file copy completes with visible progress at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      // ~1s per file × 3 files = ~3s, comfortably past the 1.5s dialog gate.
      await page.goto("/?path=/home/user/Documents&mockLatency=copy_entries:1000");
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
      await expect.poll(() => dialog.evaluate(element => {
        const box = element.getBoundingClientRect();
        return Math.min(box.left, box.top, innerWidth - box.right, innerHeight - box.bottom);
      })).toBeGreaterThanOrEqual(15);
      const box = (await dialog.boundingBox())!;
      expect(Math.abs(width - box.x - box.width - 16)).toBeLessThan(1);

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

  }

  test("cancelling a running copy stops it before the remaining files are copied", async ({
    page,
  }) => {
    // The page clock (real-time until advanced) lets the end of the test jump
    // over the copy latency instead of sleeping through it (#1123).
    await page.clock.install();
    // 2s per file: at the 1.5s dialog gate the first file is still copying, so
    // cancelling then guarantees files #2 and #3 never start.
    await page.goto("/?path=/home/user/Documents&mockLatency=copy_entries:2000");
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
    // never lands.) Advance past the time an uncancelled batch would need to
    // copy every file, so a cancellation that failed to stop it shows here.
    await page.clock.runFor(6_500);
    const names = await page.locator(".entry-item .entry-name").allTextContents();
    const copied = ["report.pdf", "budget.xlsx", "presentation.pptx"].filter((n) =>
      names.includes(n),
    );
    expect(copied.length).toBeLessThan(3);
  });
});

test("completed image jobs show cost in the notification and Jobs panel, and reveal the selected file", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents"); await waitForEntries(page);
  await page.evaluate(async () => {
    const { createPluginJobsController, windowJobSink } = await import("/src/lib/state/plugin-jobs.ts");
    const handlers = new Map<string, (value: any) => void>();
    const controller = createPluginJobsController({ ...windowJobSink, listen: async (name, handler) => { handlers.set(name, handler); return () => {}; } });
    await controller.accept({ kind: "openai-image", label: "Generated image", detail: "A landscape", presentation: "image" }, async () => ({ ok: true, data: 99003 }));
    handlers.get("openai-image-complete")!({ jobId: 99003, outputPath: "/home/user/Pictures/screenshot.png", cost: { amount: "0.075", currency: "USD", estimated: true, source: "ratecard:openai-images:2026-10-11" }, reveal: { kind: "file", path: "/home/user/Pictures/screenshot.png" } });
    await controller.dispose();
  });
  await expect(page.locator(".toast").filter({ hasText: "Generated image complete: screenshot.png · ≈US$0.08" })).toBeVisible();
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("dialog", { name: "Background Jobs", exact: true });
  await expect(panel.locator('[data-job-id="99003"] .job-time')).toContainText("≈US$0.08");
  await panel.getByRole("button", { name: "Show image", exact: true }).click();
  await expect(panel).toBeHidden();
  const pane = await activeExplorerPane(page);
  await expect(pane.locator(".entry-item.selected")).toHaveText(/screenshot.png/);
  await expect(pane.locator(".entry-item.selected")).toBeInViewport();
});

test("large valid costs remain inside both job panels on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/?path=/home/user/Documents"); await waitForEntries(page);
  await page.evaluate(async () => {
    const { jobsStore } = await import("/src/lib/state/jobs.svelte.ts");
    jobsStore.addJob(99006, "Large cost image", "", "openai-image", "image");
    jobsStore.completeJob(99006, "/home/user/Pictures/screenshot.png", { cost: { amount: `${"9".repeat(200)}.995`, currency: "USD", estimated: false, source: "fixture" }, reveal: { kind: "file", path: "/home/user/Pictures/screenshot.png" } });
  });
  const progress = page.getByRole("region", { name: "Background progress" });
  await expect(progress).toContainText(`US$1${"0".repeat(200)}.00`);
  expect(await progress.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.keyboard.press("Control+j");
  const panel = page.getByRole("dialog", { name: "Background Jobs", exact: true });
  await expect(panel.locator(".job-time")).toContainText(`US$1${"0".repeat(200)}.00`);
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await panel.getByRole("button", { name: "Show image", exact: true }).click();
  const pane = await activeExplorerPane(page);
  await expect(pane.locator(".entry-item.selected")).toHaveText(/screenshot.png/);
  await expect(pane.locator(".entry-item.selected")).toBeInViewport();
});

test("Show image recovers a folder listing hidden by a failed navigation", async ({ page }) => {
  await page.goto("/?path=/home/user/Pictures"); await waitForEntries(page);
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const { jobsStore } = await import("/src/lib/state/jobs.svelte.ts");
    await windowTabsManager.getActiveExplorer()!.navigateTo("/deleted");
    jobsStore.addJob(99007, "Recovered image", "", "openai-image", "image");
    jobsStore.completeJob(99007, "/home/user/Pictures/screenshot.png", {
      reveal: { kind: "file", path: "/home/user/Pictures/screenshot.png" },
    });
  });
  const pane = await activeExplorerPane(page);
  await expect(pane).toContainText("Path not found: /deleted");
  await page.getByRole("region", { name: "Background progress" }).getByRole("button", { name: "Show image", exact: true }).click();
  await expect(pane).not.toContainText("Path not found: /deleted");
  await expect(pane.locator(".entry-item.selected")).toHaveText(/screenshot.png/);
  await expect(pane.locator(".entry-item.selected")).toBeInViewport();
});
