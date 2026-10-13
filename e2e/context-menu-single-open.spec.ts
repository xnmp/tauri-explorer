/**
 * E2E: each right-click gesture shows the context menu once, without a blink
 * (#1062).
 *
 * The reported "menu loads twice" was WebKitGTK dropping the menu's
 * backdrop-filter surface for one frame when a composited (opacity/transform)
 * entrance animation ended, so the menu blinked see-through ~100 ms after
 * opening. Chromium cannot render that glitch, so this suite pins the contract
 * that prevents it: menu surfaces (`.context-menu`, `.submenu`) and their
 * contents never run composited animations and are fully opaque on every
 * visible frame; the main menu is revealed (with its entrance) once, only
 * after its hidden measuring frame; and each gesture mounts it exactly once.
 */
import { test, expect, type Locator, type Page } from "./fixtures";
import { ALL_VIEW_MODES, seedSettings, waitForEntries, type ViewMode } from "./helpers";

const START_PATH = "/home/user/Pictures";

/** Layouts: bare, and the reported one (preview pane on, two panes). */
const LAYOUTS = ["single pane", "preview pane + two panes"] as const;

type Probe = {
  inserted: number;
  reveals: number;
  revealsWhileHidden: number;
  unanimatedReveals: number;
  compositedAnimations: number;
  translucentFrames: number;
};

const ZERO = { revealsWhileHidden: 0, unanimatedReveals: 0, compositedAnimations: 0, translucentFrames: 0 };

const MENU_SURFACE = ".context-menu, .submenu";

/**
 * Everything is observed synchronously (mutations, getAnimations, computed
 * style per frame). WebKit dispatches animationstart/animationend lazily — up
 * to ~400 ms after the animation began locally, later on CI — so counting
 * those events attributed them to the wrong gesture (#1071).
 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate((surface) => {
    const w = window as unknown as { __ctxProbe: Probe };
    w.__ctxProbe = { inserted: 0, reveals: 0, revealsWhileHidden: 0, unanimatedReveals: 0, compositedAnimations: 0, translucentFrames: 0 };
    // Properties WebKit animates on the compositor (layer torn down at the end).
    const COMPOSITED = ["opacity", "transform", "translate", "scale", "rotate", "filter", "backdropFilter"];
    const seen = new WeakSet<Animation>();
    const inspectAnimations = (el: HTMLElement) => {
      for (const animation of el.getAnimations({ subtree: true })) {
        if (seen.has(animation)) continue;
        seen.add(animation);
        const keyframes = (animation.effect as KeyframeEffect).getKeyframes();
        if (keyframes.some((frame) => COMPOSITED.some((prop) => prop in frame))) w.__ctxProbe.compositedAnimations++;
      }
    };
    const revealed = (el: HTMLElement) => {
      w.__ctxProbe.reveals++;
      // Also at reveal: headless WebKit can finish a short entrance before the
      // next animation frame samples it.
      inspectAnimations(el);
      const style = getComputedStyle(el);
      if (style.visibility === "hidden") w.__ctxProbe.revealsWhileHidden++;
      if (!style.animationName.includes("menuReveal")) w.__ctxProbe.unanimatedReveals++;
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          const el = record.target as HTMLElement;
          const was = (record.oldValue ?? "").split(/\s+/).includes("revealed");
          if (el.classList.contains("context-menu") && el.classList.contains("revealed") && !was) revealed(el);
          continue;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const menu = node.matches(".context-menu") ? node : node.querySelector<HTMLElement>(".context-menu");
          if (!menu) continue;
          w.__ctxProbe.inserted++;
          if (menu.classList.contains("revealed")) revealed(menu);
        }
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    // Every frame: any visible menu surface must be fully opaque, and no
    // animation on a surface or inside it may animate a composited property.
    const sample = () => {
      for (const el of document.querySelectorAll<HTMLElement>(surface)) {
        const style = getComputedStyle(el);
        if (style.visibility !== "hidden" && el.offsetParent !== null && style.opacity !== "1") {
          w.__ctxProbe.translucentFrames++;
        }
        inspectAnimations(el);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, MENU_SURFACE);
}

async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ctxProbe: Probe };
    for (const key of Object.keys(w.__ctxProbe) as (keyof Probe)[]) w.__ctxProbe[key] = 0;
  });
}

/** Counts after letting any deferred re-open (rAF, timers, effects) settle. */
async function settledCounts(page: Page): Promise<Probe> {
  await expect(page.locator(".context-menu")).toBeVisible();
  await page.waitForTimeout(500);
  return await page.evaluate(
    () => (window as unknown as { __ctxProbe: Probe }).__ctxProbe,
  );
}


/** A viewport point inside `row` that the open menu does not cover. */
async function pointClearOfMenu(page: Page, row: Locator): Promise<{ x: number; y: number }> {
  const menu = (await page.locator(".context-menu").boundingBox())!;
  const box = (await row.boundingBox())!;
  // Rows can be wider than their scroller (Details in a narrow pane): only
  // points inside the scroller's visible box are reachable by the pointer.
  const view = (await page.locator(".file-list").first().boundingBox())!;
  for (let x = Math.max(box.x, view.x) + 8; x < Math.min(box.x + box.width, view.x + view.width) - 8; x += 8) {
    const y = box.y + box.height / 2;
    if (x < menu.x - 2 || x > menu.x + menu.width + 2 || y < menu.y - 2 || y > menu.y + menu.height + 2) {
      return { x, y };
    }
  }
  throw new Error("row is entirely covered by the context menu");
}

for (const layout of LAYOUTS) {
  for (const viewMode of ALL_VIEW_MODES satisfies readonly ViewMode[]) {
    test.describe(`Context menu opens once per gesture [${viewMode}, ${layout}]`, () => {
      test.beforeEach(async ({ page }) => {
        await seedSettings(page, { thumbnailSize: "xlarge", showPreviewPane: layout !== LAYOUTS[0] });
        await page.goto(`/?path=${encodeURIComponent(START_PATH)}&viewMode=${viewMode}`);
        await waitForEntries(page);
        if (layout !== LAYOUTS[0]) {
          // Seeded on; toggling here races the pane's first render.
          await expect(page.locator(".preview-pane")).toBeVisible();
          await page.keyboard.press("Control+\\");
          await expect(page.locator(".explorer-pane")).toHaveCount(2);
        }
        await installProbe(page);
      });

      const rows = (page: Page) => page.locator(".file-list").first().locator(".entry-item");

      test("right-click with no menu open mounts the menu once", async ({ page }) => {
        await waitForEntries(page);
        await resetProbe(page);
        await rows(page).nth(0).click({ button: "right" });
        expect(await settledCounts(page)).toEqual({ inserted: 1, reveals: 1, ...ZERO });
      });

      test("right-click on another entry while a menu is open replaces it with one mount", async ({ page }) => {
        await rows(page).nth(0).click({ button: "right" });
        await settledCounts(page);

        // The real gesture lands on the backdrop that covers the whole window.
        const second = rows(page).nth(1);
        const secondPath = await second.getAttribute("data-path");
        const { x, y } = await pointClearOfMenu(page, second);
        await resetProbe(page);
        await page.mouse.click(x, y, { button: "right" });
        await expect(second).toHaveClass(/selected/);
        expect(await settledCounts(page)).toEqual({ inserted: 1, reveals: 1, ...ZERO });
        // The menu moved to the new target rather than staying on the old one.
        await expect(page.locator(".file-list").first().locator(".entry-item.selected")).toHaveAttribute("data-path", secondPath!);
      });

      test("right-click on empty space while a menu is open mounts once", async ({ page }) => {
        await rows(page).nth(0).click({ button: "right" });
        await settledCounts(page);

        await resetProbe(page);
        const box = (await page.locator(".file-list").first().boundingBox())!;
        await page.mouse.click(box.x + 6, box.y + box.height - 6, { button: "right" });
        expect(await settledCounts(page)).toEqual({ inserted: 1, reveals: 1, ...ZERO });
      });
    });
  }
}

test("submenus reveal without composited animation", async ({ page }) => {
  await page.goto(`/?path=${encodeURIComponent(START_PATH)}`);
  await waitForEntries(page);
  await installProbe(page);
  const box = (await page.locator(".file-list").first().boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + box.height - 6, { button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible();
  await resetProbe(page);
  const trigger = page.locator(".context-menu .submenu-wrapper").first();
  await trigger.hover();
  await expect(trigger.locator(".submenu")).toBeVisible();
  await page.waitForTimeout(300);
  const probe = await page.evaluate(() => (window as unknown as { __ctxProbe: Probe }).__ctxProbe);
  expect(probe).toMatchObject({ compositedAnimations: 0, translucentFrames: 0 });
  // The submenu does animate in (motion is kept, just not composited).
  expect(await trigger.locator(".submenu").evaluate((el) => getComputedStyle(el).animationName)).toContain("menuReveal");
});
