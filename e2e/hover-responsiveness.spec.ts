import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, switchViewMode, waitForEntries } from "./helpers";

const HOME = "/?path=/home/user";
const PROFILE_ONLY = process.env.HOVER_PROFILE_ONLY === "1";
const PROFILE_BASE_URL = process.env.HOVER_PROFILE_BASE_URL ?? "";
const PROFILE_LABEL = process.env.HOVER_PROFILE_LABEL ?? "current-branch";

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
    await page.goto(`${PROFILE_BASE_URL}${HOME}`);
    await waitForEntries(page);
  });

  test("file, sidebar, and tab hover feedback has no animated settling delay", async ({ page }) => {
    const profile: Array<{
      surface: string;
      feedback: HoverFeedback;
    }> = [];

    for (const viewMode of ALL_VIEW_MODES) {
      if (viewMode !== "details") await switchViewMode(page, viewMode);
      const feedback = await hoverFeedback(
        page,
        ".entry-item:not(.selected)",
        "background",
        "backgroundColor",
      );
      profile.push({ surface: `${viewMode} entry`, feedback });
      if (!PROFILE_ONLY) {
        expectImmediateFeedback(feedback, `${viewMode} entry hover`);
        await page.screenshot({ path: `evidence/ac-1-hover-${viewMode}.png` });
      }
    }

    const sidebarFeedback = await hoverFeedback(
      page,
      ".sidebar-view.files-view .nav-item",
      "background",
      "backgroundColor",
    );
    profile.push({ surface: "sidebar navigation", feedback: sidebarFeedback });
    if (!PROFILE_ONLY) {
      expectImmediateFeedback(sidebarFeedback, "sidebar hover");
      await page.screenshot({ path: "evidence/ac-2-hover-sidebar-navigation.png" });
    }

    await page.keyboard.press("Control+t");
    await expect(page.locator(".tab")).toHaveCount(2);
    await page.waitForTimeout(300); // Let the one-shot tab entrance animation finish.
    const tabFeedback = await hoverFeedback(
      page,
      ".tab:not(.active)",
      "opacity",
      "opacity",
      "::before",
    );
    profile.push({ surface: "inactive tab", feedback: tabFeedback });
    if (!PROFILE_ONLY) {
      expectImmediateFeedback(tabFeedback, "inactive tab hover");
      await page.screenshot({ path: "evidence/ac-2-hover-inactive-tab.png" });
    }

    await page.evaluate(({ label, results }) => {
      const output = document.createElement("output");
      output.setAttribute("aria-label", "Hover profiling results");
      output.style.cssText = [
        "position:fixed",
        "top:44px",
        "right:16px",
        "z-index:2147483647",
        "padding:14px 16px",
        "border:1px solid rgba(255,255,255,.22)",
        "border-radius:8px",
        "background:rgba(16,18,24,.96)",
        "box-shadow:0 8px 28px rgba(0,0,0,.4)",
        "color:#f5f7ff",
        "font:12px/1.55 ui-monospace,monospace",
        "white-space:pre",
      ].join(";");
      output.textContent = [
        "Chromium hover profile — issue #503",
        `Measured revision: ${label}`,
        "Surface                  Delay  Active  Immediate paint",
        ...results.map(
          ({ surface, transitionMs, activeAnimations, paintMatches }) =>
            `${surface.padEnd(23)} ${`${transitionMs}ms`.padStart(6)} ${String(activeAnimations).padStart(7)}  ${paintMatches ? "final" : "settling"}`,
        ),
      ].join("\n");
      document.body.append(output);
    }, {
      label: PROFILE_LABEL,
      results: profile.map(({ surface, feedback }) => ({
        surface,
        transitionMs: feedback.transitionMs,
        activeAnimations: feedback.activeAnimations,
        paintMatches: feedback.immediatePaint === feedback.finalPaint,
      })),
    });
    await expect(page.getByLabel("Hover profiling results")).toBeVisible();
    await page.screenshot({ path: `evidence/ac-4-browser-profile-${PROFILE_LABEL}.png` });
  });

  test("hovered entries retain selection, navigation, and context-menu behavior", async ({ page }) => {
    test.skip(PROFILE_ONLY, "The profiling-only run records transition evidence without assertions");
    const file = page.locator(".entry-item:not(.directory)").first();
    await file.hover();
    await file.click();
    await expect(file).toHaveClass(/selected/);

    await file.click({ button: "right" });
    await expect(page.locator(".context-menu")).toBeVisible();
    await page.screenshot({ path: "evidence/ac-3-hover-context-menu.png" });
    await page.keyboard.press("Escape");

    const folder = page.locator(".entry-item.directory").first();
    const name = (await folder.locator(".entry-name").textContent())?.trim();
    await folder.hover();
    await folder.dblclick();
    await expect(page.locator(".breadcrumbs-container")).toContainText(name!);
  });
});
