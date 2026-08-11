/**
 * Visual regression coverage for repository-folder Git badges (issue #601).
 *
 * The mock filesystem exposes `my-project` as a repository root. Assertions
 * target the rendered SVG rather than the source component so the test follows
 * the same FileIcon output used by the browser's directory views.
 */
import { test, expect } from "./fixtures";
import { ALL_VIEW_MODES, HOME_URL, waitForEntries, switchViewMode } from "./helpers";

test.describe("Repository folder Git badge", () => {
  test("uses a compact outlined badge across directory views", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    for (const mode of ALL_VIEW_MODES) {
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
      await expect(repository.locator(".git-repo-badge-glyph path")).toHaveAttribute(
        "stroke",
        "var(--icon-git-badge-glyph, #fff)",
      );
      await expect(repository.locator(".git-repo-badge-glyph circle").first()).toHaveAttribute(
        "stroke",
        "var(--icon-git-badge-glyph, #fff)",
      );

      if (mode === "details") {
        // A 3x browser zoom keeps this evidence faithful to the running SVG
        // while making the 16px branch detail inspectable in PR review.
        await page.evaluate(() => { document.documentElement.style.zoom = "3"; });
        await repository.screenshot({ path: "evidence/ac-1-compact-git-badge.png", scale: "css" });
        await page.evaluate(() => { document.documentElement.style.zoom = ""; });
      }
      if (mode === "tiles") {
        await page.screenshot({ path: "evidence/ac-2-detailed-git-badge.png" });
      }
    }

    // The decorative treatment must not turn ordinary folders into repos.
    await expect(page.locator(".entry-item", { hasText: "Documents" }).first().locator(".git-repo-badge")).toHaveCount(0);
  });
});
