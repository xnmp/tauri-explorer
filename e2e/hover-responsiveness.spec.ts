import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, switchViewMode, waitForEntries } from "./helpers";

const HOME = "/?path=/home/user";

interface HoverFeedback {
  transitionMs: number;
  activeAnimations: number;
  immediatePaint: string;
  finalPaint: string;
}

async function hoverFeedback(
  page: Page,
  selector: string,
  property: string,
  paintProperty: "backgroundColor" | "opacity",
  pseudo?: "::before",
): Promise<HoverFeedback> {
  const target = page.locator(selector).first();
  await target.hover();

  return target.evaluate(async (element, { property, paintProperty, pseudo }) => {
      const style = getComputedStyle(element, pseudo);
      const properties = style.transitionProperty.split(",").map((value) => value.trim());
      const durations = style.transitionDuration.split(",").map((value) => {
        const trimmed = value.trim();
        return Number.parseFloat(trimmed) * (trimmed.endsWith("ms") ? 1 : 1000);
      });
      const index = properties.findIndex((value) => value === property || value === "all");
      const animations = element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === "running");
      const immediatePaint = style[paintProperty];
      await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));

      return {
        transitionMs: index < 0 ? 0 : durations[index % durations.length] ?? 0,
        activeAnimations: animations.length,
        immediatePaint,
        finalPaint: getComputedStyle(element, pseudo)[paintProperty],
      };
    },
    { property, paintProperty, pseudo },
  );
}

function expectImmediateFeedback(feedback: HoverFeedback, label: string) {
  expect(feedback.transitionMs, `${label} should not declare a settling delay`).toBe(0);
  expect(feedback.activeAnimations, `${label} should not start a hover animation`).toBe(0);
  expect(feedback.immediatePaint, `${label} should paint its final state immediately`).toBe(
    feedback.finalPaint,
  );
}

test.describe("hover responsiveness (#503)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(HOME);
    await waitForEntries(page);
  });

  test("file, sidebar, and tab hover feedback has no animated settling delay", async ({ page }) => {
    for (const viewMode of ALL_VIEW_MODES) {
      if (viewMode !== "details") await switchViewMode(page, viewMode);
      expectImmediateFeedback(
        await hoverFeedback(
          page,
          ".entry-item:not(.selected)",
          "background",
          "backgroundColor",
        ),
        `${viewMode} entry hover`,
      );
    }

    expectImmediateFeedback(
      await hoverFeedback(
        page,
        ".sidebar-view.files-view .nav-item",
        "background",
        "backgroundColor",
      ),
      "sidebar hover",
    );

    await page.keyboard.press("Control+t");
    await expect(page.locator(".tab")).toHaveCount(2);
    await page.waitForTimeout(300); // Let the one-shot tab entrance animation finish.
    expectImmediateFeedback(
      await hoverFeedback(page, ".tab:not(.active)", "opacity", "opacity", "::before"),
      "inactive tab hover",
    );
  });

  test("hovered entries retain selection, navigation, and context-menu behavior", async ({ page }) => {
    const file = page.locator(".entry-item:not(.directory)").first();
    await file.hover();
    await file.click();
    await expect(file).toHaveClass(/selected/);

    await file.click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await page.keyboard.press("Escape");

    const folder = page.locator(".entry-item.directory").first();
    const name = (await folder.locator(".entry-name").textContent())?.trim();
    await folder.hover();
    await folder.dblclick();
    await expect(page.locator(".breadcrumbs-container")).toContainText(name!);
  });
});
