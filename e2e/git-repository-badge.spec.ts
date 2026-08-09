/**
 * Visual regression coverage for repository-folder Git badges (issue #601).
 *
 * The mock filesystem exposes `my-project` as a repository root. Assertions
 * target the rendered SVG rather than the source component so the test follows
 * the same FileIcon output used by the browser's directory views.
 */
import { test, expect } from "./fixtures";
import { HOME_URL, VIEW_MODES, waitForEntries, switchViewMode } from "./helpers";

test.describe("Repository folder Git badge", () => {
  test("uses a compact outlined badge across directory views", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    for (const mode of VIEW_MODES) {
      await switchViewMode(page, mode);

      const repository = page.locator(".entry-item", { hasText: "my-project" }).first();
      const badge = repository.locator(".git-repo-badge");
      await expect(badge).toBeVisible();

      // This radius keeps the corner decoration distinct without crowding the
      // folder silhouette. It must remain themed through the established vars.
      await expect(badge).toHaveAttribute("r", mode === "tiles" ? "9.25" : "3.55");
      await expect(badge).toHaveAttribute("fill", "var(--icon-git-badge, #f05033)");

      // The translucent themed outline gives the badge depth rather than the
      // previous flat circle, while retaining the existing glyph colour token.
      const ring = repository.locator(".git-repo-badge-ring");
      await expect(ring).toBeVisible();
      await expect(ring).toHaveAttribute("stroke", "var(--icon-git-badge-glyph, #fff)");
    }
  });
});
