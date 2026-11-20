/**
 * Overlays opened from inside the window body cover the title bar (#1859).
 *
 * Dialogs and menus mounted in a pane, the sidebar or the toolbar live in
 * `.main-content`, a stacking context below the title bar in Floating Islands
 * (which lifts the bar over its islands) and below Default's active tab. Their
 * full-window backdrop must still take the title bar's pointer events: a click
 * on a tab while one is open dismisses the overlay, and switches nothing. The
 * status bar (a later sibling of the window body) is covered too.
 */
import { test, expect, type Page } from "./fixtures";
import { seedSettings, waitForEntries } from "./helpers";

const PATHS = ["/home/user/Documents", "/home/user", "/home/user/Downloads"];
/** The git graph's repository (the mock's 12-commit history). */
const REPO = "/home/user/Documents/project";
const tabs = (page: Page) => page.locator('.tab-viewport [data-region="tab"]');

async function open(page: Page, layout: string, paths = PATHS): Promise<void> {
  await page.setViewportSize({ width: 1100, height: 700 });
  await seedSettings(page, { layoutTheme: layout, showWindowControls: true, tabTitleGitRoot: false, enableGitGraph: true });
  await page.addInitScript((paths) => localStorage.setItem("explorer-tabs", JSON.stringify({
    version: 3,
    tabs: paths.map((path, i) => ({ id: `o-${i}`, kind: "explorer", activePaneId: `o-p-${i}`, layout: { type: "leaf", id: `o-p-${i}`, path } })),
    activeTabId: "o-1",
  })), paths);
  await page.goto("/");
  await waitForEntries(page);
  await expect(tabs(page)).toHaveCount(3);
}

/** Centres of every tab, the window controls and the status bar. */
async function chromePoints(page: Page): Promise<{ what: string; x: number; y: number }[]> {
  const centre = (els: Element[]) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { what: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? el.className, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const tabPoints = await tabs(page).evaluateAll(centre);
  const controls = await page.locator('[data-region="titlebar"] .control-btn').evaluateAll(centre);
  const status = await page.locator('[data-region="status-bar"]').evaluateAll(centre);
  expect(tabPoints.length, "tabs").toBeGreaterThanOrEqual(3);
  expect(controls.map((c) => c.what), "window controls").toEqual(["Minimize", "Maximize", "Close"]);
  expect(status, "status bar").toHaveLength(1);
  return [...tabPoints, ...controls, ...status];
}

/** Every point of the title bar's chrome is covered by `overlay`. */
async function expectCovers(page: Page, overlay: string, what: string): Promise<void> {
  for (const point of await chromePoints(page)) {
    const top = await page.evaluate(({ x, y, overlay }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest(overlay) ? "overlay" : `${el?.tagName}.${(el as HTMLElement | null)?.className} in ${el?.closest("[data-region]")?.getAttribute("data-region")}`;
    }, { ...point, overlay });
    expect(top, `${what}: ${point.what} is under the overlay`).toBe("overlay");
  }
}

/** A click on an inactive tab dismisses the overlay and switches nothing. */
async function expectTabClickDismisses(page: Page, overlay: string): Promise<void> {
  const active = page.locator('.tab-viewport [data-region="tab"][aria-selected="true"]');
  const activeTitle = await active.textContent();
  const tab = page.locator('.tab-viewport [data-region="tab"][aria-selected="false"]').first();
  const box = (await tab.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(overlay)).toHaveCount(0);
  await expect(active).toHaveText(activeTitle!);
}

for (const layout of ["floating-islands", "default"]) {
  test.describe(`Overlays cover the title bar: ${layout} (#1859)`, () => {
    test("a pane's delete dialog", async ({ page }) => {
      await open(page, layout);
      await page.locator(".entry-item").first().click();
      await page.keyboard.press("Delete");
      const dialog = "[role='alertdialog']";
      await expect(page.locator(`${dialog} .dialog`)).toBeVisible();
      await expectCovers(page, dialog, "delete dialog");
      await expectTabClickDismisses(page, dialog);
    });

    test("the Details column menu", async ({ page }) => {
      await open(page, layout);
      const header = (await page.locator(".column-headers").boundingBox())!;
      await page.mouse.click(header.x + 120, header.y + header.height / 2, { button: "right" });
      await expect(page.locator(".column-menu")).toBeVisible();
      await expectCovers(page, ".column-menu-backdrop, .column-menu", "column menu");
      await expectTabClickDismisses(page, ".column-menu");
    });

    test("a file's context menu", async ({ page }) => {
      await open(page, layout);
      await page.locator(".entry-item").first().click({ button: "right" });
      await expect(page.locator(".context-menu")).toBeVisible();
      await expectCovers(page, ".context-menu-backdrop, .context-menu", "context menu");
      await expectTabClickDismisses(page, ".context-menu");
    });

    test("the sidebar section menu", async ({ page }) => {
      await open(page, layout);
      await page.locator('[data-region="sidebar-section-header"]').first().click({ button: "right" });
      await expect(page.locator(".section-menu")).toBeVisible();
      await expectCovers(page, ".section-menu-backdrop, .section-menu", "section menu");
      await expectTabClickDismisses(page, ".section-menu");
    });

    test("a git graph prompt", async ({ page }) => {
      await open(page, layout, [PATHS[0], REPO, PATHS[2]]);
      await page.keyboard.press("Control+Shift+p");
      await page.locator("input:focus").fill("Toggle Commit Graph");
      await page.keyboard.press("Enter");
      const view = page.locator('[data-testid="git-graph-view"]');
      await expect(view.locator(".commit-row").first()).toContainText("Uncommitted Changes");
      await view.locator(".commit-row").nth(2).click({ button: "right" });
      await page.locator('[data-testid="git-graph-menu"]').getByText("Create Branch…").click();
      const prompt = '[data-testid="git-graph-prompt"]';
      await expect(page.locator(prompt)).toBeVisible();
      await expectCovers(page, `.menu-backdrop, ${prompt}`, "git graph prompt");
      await expectTabClickDismisses(page, prompt);
    });
  });
}
