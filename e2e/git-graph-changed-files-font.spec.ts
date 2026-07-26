/**
 * Changed-files list in the git graph must render in the regular app font (#499).
 *
 * The bug was a `font-family: var(--font-mono, monospace)` on the changed-file
 * rows. `--font-mono` is defined nowhere in the codebase, so the declaration
 * always resolved to the generic `monospace` family while the rest of the UI
 * renders in `var(--font-family)` (the Inter stack set on `body`).
 *
 * The only layer that produces the observable ("what typeface does the user
 * see?") is the rendered document, after the cascade resolves — so these
 * assertions read `getComputedStyle().fontFamily` off real elements rather
 * than inspecting a CSS constant. The screenshots are captured as a side
 * effect of the assertions so they are guaranteed to depict the asserted state.
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

const MONOSPACE = /monospace|ui-monospace|Menlo|Consolas|Courier|SFMono/i;

/**
 * PNGs aren't byte-reproducible, so writing straight to the committed
 * `evidence/` copy would dirty the tree on every ordinary e2e run (and leave a
 * half-updated set behind a mid-run failure). Default to gitignored
 * test-results/; refresh the committed evidence with CAPTURE_EVIDENCE=1.
 */
const shotPath = (name: string) =>
  process.env.CAPTURE_EVIDENCE ? `evidence/${name}` : `test-results/${name}`;

async function openGraphViaPalette(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(
    page.locator('[data-testid="git-graph-view"] .commit-row').first(),
  ).toContainText("Uncommitted Changes");
}

/** Computed font-family of the first element matching `selector`. */
function fontFamilyOf(page: import("@playwright/test").Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no element for ${sel}`);
    return getComputedStyle(el).fontFamily;
  }, selector);
}

test.describe("Git graph changed-files font (#499)", () => {
  test("AC 1: file names and status letters render in the app font", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view.locator(".commit-row", { hasText: "Uncommitted Changes" }).first().click();

    // The changed-files list is rendered with real file rows.
    const filePath = view.locator(".file-path").first();
    await expect(filePath).toBeVisible();
    await expect(filePath).not.toBeEmpty();

    const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    const pathFont = await fontFamilyOf(page, '[data-testid="git-graph-view"] .file-path');
    const statusFont = await fontFamilyOf(page, '[data-testid="git-graph-view"] .file-status');

    // The app font is a real named stack, not the generic monospace fallback.
    expect(bodyFont).not.toMatch(MONOSPACE);

    // The observable: the changed-files rows are typographically identical to
    // the rest of the UI. Reverting the fix restores "monospace" here.
    expect(pathFont).toBe(bodyFont);
    expect(statusFont).toBe(bodyFont);
    expect(pathFont).not.toMatch(MONOSPACE);
    expect(statusFont).not.toMatch(MONOSPACE);

    await view.locator(".detail-files-col").first().screenshot({
      path: shotPath("ac-1-changed-files-app-font.png"),
    });
  });

  test("AC 2: inline diff content still renders monospace", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view.locator(".commit-row", { hasText: "Uncommitted Changes" }).first().click();

    // Opening a file's diff shows code, which must stay monospace so the
    // fix for AC 1 cannot have been applied too broadly.
    await view.locator(".detail-file").first().click();
    const diff = view.locator('[data-testid="git-graph-file-diff"] .diff-lines').first();
    await expect(diff).toBeVisible();

    const diffFont = await fontFamilyOf(
      page,
      '[data-testid="git-graph-file-diff"] .diff-lines',
    );
    expect(diffFont).toMatch(MONOSPACE);

    await view.locator('[data-testid="git-graph-file-diff"]').first().screenshot({
      path: shotPath("ac-2-diff-monospace.png"),
    });
  });
});
