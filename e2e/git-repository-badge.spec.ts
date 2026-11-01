/**
 * Visual regression coverage for repository-folder Git decoration (#601,
 * #1477).
 *
 * The mock filesystem exposes `my-project` as a repository root. Assertions
 * target the rendered SVG rather than the source component so the test follows
 * the same FileIcon output used by the browser's directory views. Since #1477
 * the decoration is an emblem on the folder body, not a bottom-right badge:
 * that corner is where the Tiles peek caret is drawn.
 */
import { test, expect } from "./fixtures";
import { ALL_VIEW_MODES, HOME_URL, waitForEntries, switchViewMode } from "./helpers";

const EVIDENCE = "screenshots/fix/peek-carets-overlap-with-git-icon";

test.describe("Repository folder Git emblem", () => {
  // Capture small SVG details at high density without resizing the layout
  // between view checks (temporary CSS zoom races pane/virtualizer updates).
  test.use({ deviceScaleFactor: 3 });

  test("draws a themed emblem on the folder body, clear of the peek caret, across directory views", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    for (const mode of ALL_VIEW_MODES) {
      await switchViewMode(page, mode);

      const repository = page.locator(".pane-tree:not(.retained) .entry-item", { hasText: "my-project" }).first();
      const plate = repository.locator(".git-repo-emblem-plate");
      await expect(plate).toBeVisible();
      await expect(plate).toHaveAttribute("fill", "var(--icon-git-badge, #f05033)");
      await expect(repository.locator(".git-repo-emblem-glyph")).toHaveAttribute("stroke", "var(--icon-git-badge-glyph, #fff)");
      // The old corner badge is gone in every view.
      await expect(repository.locator(".git-repo-badge")).toHaveCount(0);

      // The emblem is centred on the folder icon horizontally and sits in its
      // lower body, never pinned to the bottom-right corner.
      const icon = repository.locator("[data-drag-icon] svg").first();
      const iconBox = (await icon.boundingBox())!;
      const plateBox = (await plate.boundingBox())!;
      const plateCx = plateBox.x + plateBox.width / 2;
      expect(Math.abs(plateCx - (iconBox.x + iconBox.width / 2))).toBeLessThan(iconBox.width * 0.06);
      expect(plateBox.x + plateBox.width).toBeLessThan(iconBox.x + iconBox.width * 0.8);

      if (mode === "tiles") {
        const caret = repository.locator(".tile-caret");
        await expect(caret).toBeVisible();
        const caretBox = (await caret.boundingBox())!;
        const disjoint = plateBox.x + plateBox.width <= caretBox.x || plateBox.y + plateBox.height <= caretBox.y;
        expect(disjoint, `emblem ${JSON.stringify(plateBox)} vs caret ${JSON.stringify(caretBox)}`).toBe(true);
        await repository.screenshot({ path: `${EVIDENCE}/tiles-emblem-beside-peek-caret.png`, scale: "device" });
        await page.screenshot({ path: `${EVIDENCE}/tiles-view.png`, scale: "css" });
      }
      if (mode === "details") {
        await repository.screenshot({ path: `${EVIDENCE}/details-compact-emblem.png`, scale: "device" });
      }
    }

    // The decorative treatment must not turn ordinary folders into repos.
    await expect(page.locator(".pane-tree:not(.retained) .entry-item", { hasText: "Documents" }).first().locator(".git-repo-emblem")).toHaveCount(0);
  });
});
