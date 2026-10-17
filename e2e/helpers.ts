/**
 * Shared helpers for e2e tests.
 */

import { expect, type Locator, type Page } from "@playwright/test";

/** The three view modes */
export const ALL_VIEW_MODES = ["details", "list", "tiles"] as const;
export type ViewMode = (typeof ALL_VIEW_MODES)[number];

/**
 * Default mode for fast test runs. Set ALL_VIEW_MODES_FLAG=1 to test all three.
 * Run with: ALL_VIEW_MODES=1 bun run test:e2e
 */
const allModes = !!process.env.ALL_VIEW_MODES;

export const VIEW_MODES: readonly ViewMode[] = allModes
  ? ALL_VIEW_MODES
  : ["details"];

/**
 * A view mode plus the Folder Peek setting that selects its List renderer.
 * `classic` = Folder Peek off (row-major List); only meaningful for "list".
 * ALL_VIEW_MODES runs add the classic List so both renderers stay covered.
 */
export interface ViewVariant { readonly name: string; readonly viewMode: ViewMode; readonly classic: boolean }
export const variantsFor = (modes: readonly ViewMode[]): readonly ViewVariant[] => [
  ...modes.map((viewMode) => ({ name: viewMode, viewMode, classic: false })),
  ...(modes.includes("list") ? [{ name: "list-classic", viewMode: "list" as const, classic: true }] : []),
];
export const VIEW_VARIANTS: readonly ViewVariant[] = variantsFor(VIEW_MODES);
export const ALL_VIEW_VARIANTS: readonly ViewVariant[] = variantsFor(ALL_VIEW_MODES);

// Print once at import time so it's visible in test output
if (!allModes) {
  console.log(
    "\x1b[33m⚡ Running e2e tests in details view only (fast mode).\n" +
    "   Set ALL_VIEW_MODES=1 to test all 3 view modes:\n" +
    "   ALL_VIEW_MODES=1 bun run test:e2e\x1b[0m",
  );
}

/** The Ctrl/Cmd modifier for multi-select clicks: Meta on macOS, Control elsewhere. */
export const MULTI_SELECT_MODIFIER: "Meta" | "Control" =
  process.platform === "darwin" ? "Meta" : "Control";

/** Home URL for most tests */
export const HOME_URL = "/?path=/home/user";

/** Every built-in theme id (src/lib/themes/*.css). */
export const BUILT_IN_THEMES = [
  "aurora", "catppuccin", "dark", "desert", "gruvbox", "hacker",
  "horizon", "light", "nord", "ocean-blue", "solarized-light", "tahoe",
] as const;

/** Wait for the file list to be populated with entry items */
export async function waitForEntries(page: Page) {
  await page.waitForSelector(".file-list");
  // Hidden retained tabs (#1173) keep their rows mounted.
  await page.locator(".entry-item:visible").first().waitFor({ timeout: 5000 });
}

/** Pane activation is manager state; `.active` only paints the split-pane border. */
export async function activeExplorerPane(page: Page) {
  const paneId = await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    return windowTabsManager.activePaneId;
  });
  return page.locator(`.explorer-pane[data-pane-id="${paneId}"]`);
}

/** Execute a selection-aware action through the real command palette.
 * An exact label wins over longer labels it prefixes ("Toggle Folder Peek"
 * vs "Toggle Folder Peek Carets"); dynamic labels such as "Dock Preview Pane
 * Auto (currently …)" still match by substring. */
export async function runPaletteCommand(page: Page, label: string) {
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator(".search-input").fill(label);
  const matching = palette.locator(".command-item").filter({ hasText: label });
  await matching.first().waitFor();
  const exactLabel = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const exact = matching.filter({ has: page.locator(".command-label", { hasText: exactLabel }) });
  await ((await exact.count()) > 0 ? exact : matching).click();
  await expect(palette).toBeHidden();
}

/**
 * Switch view mode via right-click context menu.
 * This is the most reliable method as it uses real UI interactions.
 */
export async function switchViewMode(page: Page, mode: ViewMode) {
  const modeLabels: Record<ViewMode, string> = {
    details: "Details",
    list: "List",
    tiles: "Tiles",
  };

  // Clear selection first — view options only appear in background context menu
  await page.keyboard.press("Escape");
  await page.locator(".entry-item.selected:visible").first().waitFor({ state: "detached", timeout: 2000 }).catch(() => {});

  // Right-click on genuinely empty space: just below the LAST entry's box.
  // A fixed midpoint breaks whenever the mock listing grows enough for rows
  // to reach it — the click then lands on an entry and opens the entry menu,
  // which has no View options (see #474; 173 list/tiles tests failed this way).
  // `:visible` throughout: recently active tabs stay mounted but hidden (#1173).
  const content = page.locator(".file-list .content:visible").first();
  const box = await content.boundingBox();
  const lastEntry = page.locator(".entry-item:visible").last();
  const lastBox = await lastEntry.boundingBox();
  let clickY = box ? Math.round(box.height / 2) : 300;
  if (box && lastBox) {
    const below = Math.round(lastBox.y + lastBox.height - box.y) + 12;
    // Keep enough headroom for the menu to render without viewport clipping;
    // the empty band below the last row is at least this tall in every mock dir.
    clickY = Math.min(below, Math.round(box.height) - 8);
  }
  // Height-filled List columns can reach below a short final column. Use the
  // slot gap after the first row, rather than the last column's tail at x=10.
  if (box && await content.locator(".list-canvas").isVisible()) {
    const first = await content.locator(".list-item").first().boundingBox();
    if (first) clickY = Math.round(first.y + first.height - box.y) + 2;
  }
  await content.click({ button: "right", position: { x: 10, y: clickY } });

  // Wait for context menu
  const contextMenu = page.locator(".context-menu");
  await contextMenu.waitFor({ state: "visible", timeout: 2000 });

  // Click the view mode option
  const viewOption = contextMenu.locator(`.menu-item:has-text("${modeLabels[mode]}")`);
  await viewOption.click();

  // Wait for the new view container, then for entries to appear in it
  const viewSelector: Record<ViewMode, string> = {
    details: ".details-view",
    list: ".list-view",
    tiles: ".tiles-view",
  };
  await page.locator(`${viewSelector[mode]}:visible`).waitFor({ timeout: 3000 });
  await page.locator(".entry-item:visible").first().waitFor({ timeout: 3000 });
  if (mode === "list" && await content.locator(".list-canvas").count() > 0) {
    // The initial column window follows the first geometry delivery. A mounted
    // option can precede it, so counting entries at that point samples setup.
    await content.locator(".list-scroller").evaluate(element => new Promise<void>(resolve => {
      const observer = new ResizeObserver(() => { observer.disconnect(); resolve(); });
      observer.observe(element);
    }));
  }
}

/**
 * Dispatch a keyboard shortcut via JS dispatchEvent.
 * Playwright's keyboard.press("Control+c") triggers Chromium's native clipboard
 * which hangs in headless mode. Using dispatchEvent bypasses the native clipboard
 * while still exercising the app's keydown handler.
 */
export async function pressShortcut(
  page: Page,
  key: string,
  modifiers: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
) {
  await page.evaluate(
    ({ key, ctrlKey, shiftKey, altKey }) => {
      const el = document.activeElement || document.body;
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: `Key${key.toUpperCase()}`,
          ctrlKey: ctrlKey ?? false,
          shiftKey: shiftKey ?? false,
          altKey: altKey ?? false,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { key, ...modifiers },
  );
}

/**
 * Seed `explorer-settings` via an init script, so it is re-applied on EVERY
 * navigation/reload of `page` (not just the next one). Do not use this at a
 * site where a test changes a setting in-app and then reloads to check that
 * the change persisted — the init script would clobber the in-app change.
 *
 * By default `patch` is merged into whatever `explorer-settings` already
 * holds at each load. Pass `{ replace: true }` to write `patch` as the
 * entire settings object instead (for sites that don't need to preserve any
 * existing value).
 */
export async function seedSettings(
  page: Page,
  patch: Record<string, unknown>,
  options?: { replace?: boolean },
): Promise<void> {
  await page.addInitScript(
    ({ patch, replace }) => {
      const merged = replace
        ? patch
        : { ...JSON.parse(localStorage.getItem("explorer-settings") || "{}"), ...patch };
      localStorage.setItem("explorer-settings", JSON.stringify(merged));
    },
    { patch, replace: options?.replace ?? false },
  );
}

/**
 * Merge `patch` into the currently stored `explorer-settings` once, then
 * reload `page` so the app picks it up. Unlike `seedSettings`, this does not
 * re-apply on subsequent reloads. Callers keep any post-reload wait (e.g.
 * `waitForEntries`) at the call site — this helper does not add one.
 */
export async function applySettingsAndReload(
  page: Page,
  patch: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((patch) => {
    const merged = { ...JSON.parse(localStorage.getItem("explorer-settings") || "{}"), ...patch };
    localStorage.setItem("explorer-settings", JSON.stringify(merged));
  }, patch);
  await page.reload();
}

/** Focus the last sequential focus target before the rows in DOM order. */
export async function focusBeforeFileList(page: Page): Promise<void> {
  const focused = await page.evaluate(() => {
    // Recently active tabs stay mounted but hidden (#1173).
    const rowViewport = document.querySelector(".pane-tree:not(.retained) .file-list .file-rows");
    if (!rowViewport) return null;
    const candidates = [...document.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => {
      const style = getComputedStyle(element);
      return element.tabIndex >= 0 && style.display !== "none" && style.visibility !== "hidden"
        && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
        && !!(element.compareDocumentPosition(rowViewport) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    const previous = candidates.at(-1);
    previous?.focus();
    return previous ? { tag: previous.tagName, className: previous.className } : null;
  });
  expect(focused, "the file list must have a preceding sequential focus target").not.toBeNull();
}

/** Resolves once the element's client/scroll width has been unchanged for `quietMs`; WebKit resizes the pane after first paint. */
export async function waitForStableWidth(scroller: Locator, quietMs = 400): Promise<void> {
  await scroller.evaluate((element, quiet) => new Promise<void>((resolve) => {
    const read = () => `${element.clientWidth}:${element.scrollWidth}`;
    let last = read();
    let since = performance.now();
    const tick = () => {
      const now = read();
      if (now !== last) { last = now; since = performance.now(); }
      if (performance.now() - since >= quiet) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), quietMs);
}
