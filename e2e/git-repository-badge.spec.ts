/**
 * Visual regression coverage for repository-folder Git decoration (#601,
 * #1477, #1490).
 *
 * The mock filesystem exposes `my-project` as a repository root. Assertions
 * target the rendered SVG rather than the source component so the test follows
 * the same FileIcon output used by the browser's directory views. Since #1490
 * a repository is a Git-coloured folder carrying a branch glyph on its body,
 * the way an icon pack draws its special folders; the glyph stays out of the
 * bottom-right corner, where the Tiles peek caret is drawn (#1477).
 */
import { test, expect } from "./fixtures";
import { ALL_VIEW_MODES, HOME_URL, waitForEntries, switchViewMode } from "./helpers";

const EVIDENCE = "screenshots/fix/git-folder-icon";

test.describe("Repository folder Git emblem", () => {
  // Capture small SVG details at high density without resizing the layout
  // between view checks (temporary CSS zoom races pane/virtualizer updates).
  test.use({ deviceScaleFactor: 3 });

  test("draws a Git-coloured folder with a centred branch glyph, clear of the peek caret, across directory views", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    for (const mode of ALL_VIEW_MODES) {
      await switchViewMode(page, mode);

      const repository = page.locator(".pane-tree:not(.retained) .entry-item", { hasText: "my-project" }).first();
      const ordinary = page.locator(".pane-tree:not(.retained) .entry-item", { hasText: "Documents" }).first();
      const emblem = repository.locator(".git-repo-emblem");
      await expect(emblem).toBeVisible();
      // Material (the default pack) knocks the glyph out of the solid folder.
      await expect(emblem).toHaveAttribute("stroke", "var(--icon-git-badge-glyph, var(--background-solid, #fff))");
      await expect(emblem.locator("circle")).toHaveCount(3);
      // No foreign plate or corner badge remains.
      await expect(repository.locator(".git-repo-badge, .git-repo-emblem-plate")).toHaveCount(0);

      // The folder itself takes the Git colour; ordinary folders keep theirs.
      const folderColour = (row: typeof repository) => row.locator(".folder-icon").first().evaluate((el) => getComputedStyle(el).color);
      const [repoColour, plainColour, background] = await Promise.all([
        folderColour(repository), folderColour(ordinary),
        emblem.evaluate((el) => getComputedStyle(el).stroke),
      ]);
      expect(repoColour).not.toBe(plainColour);
      expect(background).not.toBe(repoColour);

      // The glyph is centred on the folder icon horizontally and sits in its
      // lower body, never pinned to the bottom-right corner.
      const icon = repository.locator("[data-drag-icon] svg").first();
      const iconBox = (await icon.boundingBox())!;
      // Union of the three node discs: they bound the glyph's painted extent.
      // (Chromium's box for the stroked <g> is inflated beyond its paint.)
      const nodes = await Promise.all((await emblem.locator("circle").all()).map(async (n) => (await n.boundingBox())!));
      const left = Math.min(...nodes.map((b) => b.x)), top = Math.min(...nodes.map((b) => b.y));
      const glyphBox = { x: left, y: top, width: Math.max(...nodes.map((b) => b.x + b.width)) - left, height: Math.max(...nodes.map((b) => b.y + b.height)) - top };      const glyphCx = glyphBox.x + glyphBox.width / 2;
      expect(Math.abs(glyphCx - (iconBox.x + iconBox.width / 2))).toBeLessThan(iconBox.width * 0.06);
      expect(glyphBox.x + glyphBox.width).toBeLessThan(iconBox.x + iconBox.width * 0.8);

      if (mode === "tiles") {
        const caret = repository.locator(".tile-caret");
        await expect(caret).toBeVisible();
        const caretBox = (await caret.boundingBox())!;
        const disjoint = glyphBox.x + glyphBox.width <= caretBox.x || glyphBox.y + glyphBox.height <= caretBox.y;
        expect(disjoint, `glyph ${JSON.stringify(glyphBox)} vs caret ${JSON.stringify(caretBox)}`).toBe(true);
        await repository.screenshot({ path: `${EVIDENCE}/after-tiles-glyph-beside-peek-caret.png`, scale: "device" });
      }
      if (mode === "details") {
        await repository.screenshot({ path: `${EVIDENCE}/after-details-compact-glyph.png`, scale: "device" });
      }
    }

    // The decorative treatment must not turn ordinary folders into repos.
    await expect(page.locator(".pane-tree:not(.retained) .entry-item", { hasText: "Documents" }).first().locator(".git-repo-emblem")).toHaveCount(0);
  });
});
