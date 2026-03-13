/**
 * Shared helpers for e2e tests.
 */

import type { Page } from "@playwright/test";

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

// Print once at import time so it's visible in test output
if (!allModes) {
  console.log(
    "\x1b[33m⚡ Running e2e tests in details view only (fast mode).\n" +
    "   Set ALL_VIEW_MODES=1 to test all 3 view modes:\n" +
    "   ALL_VIEW_MODES=1 bun run test:e2e\x1b[0m",
  );
}

/** Home URL for most tests */
export const HOME_URL = "/?path=/home/user";

/** Wait for the file list to be populated with entry items */
export async function waitForEntries(page: Page) {
  await page.waitForSelector(".file-list");
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
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

  // Right-click on empty space to open context menu
  const content = page.locator(".file-list .content").first();
  await content.click({ button: "right", position: { x: 10, y: 400 } });

  // Wait for context menu
  const contextMenu = page.locator(".context-menu");
  await contextMenu.waitFor({ state: "visible", timeout: 2000 });

  // Click the view mode option
  const viewOption = contextMenu.locator(`.menu-item:has-text("${modeLabels[mode]}")`);
  await viewOption.click();

  // Wait for re-render
  await page.waitForTimeout(200);

  // Wait for entries to appear in the new view mode
  await page.locator(".entry-item").first().waitFor({ timeout: 3000 });
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
