import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, switchViewMode, waitForEntries } from "./helpers";

const HOME = "/?path=/home/user";

async function hoverTransitionMs(
  page: Page,
  selector: string,
  property: string,
  pseudo?: "::before",
): Promise<number> {
  const target = page.locator(selector).first();
  await target.hover();

  return target.evaluate(
    (element, { property, pseudo }) => {
      const style = getComputedStyle(element, pseudo);
      const properties = style.transitionProperty.split(",").map((value) => value.trim());
      const durations = style.transitionDuration.split(",").map((value) => {
        const trimmed = value.trim();
        return Number.parseFloat(trimmed) * (trimmed.endsWith("ms") ? 1 : 1000);
      });
      const index = properties.findIndex((value) => value === property || value === "all");
      return index < 0 ? 0 : durations[index % durations.length] ?? 0;
    },
    { property, pseudo },
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
      expect(
        await hoverTransitionMs(page, ".entry-item", "background"),
        `${viewMode} entry hover should settle in the first rendered frame`,
      ).toBe(0);
    }

    expect(
      await hoverTransitionMs(page, ".sidebar-view.files-view .nav-item", "background"),
      "sidebar hover should settle in the first rendered frame",
    ).toBe(0);

    await page.keyboard.press("Control+t");
    await expect(page.locator(".tab")).toHaveCount(2);
    expect(
      await hoverTransitionMs(page, ".tab:not(.active)", "opacity", "::before"),
      "inactive tab hover should settle in the first rendered frame",
    ).toBe(0);
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
