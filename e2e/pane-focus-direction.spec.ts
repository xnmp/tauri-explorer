/**
 * Directional pane focus (#501).
 *
 * Plain Alt+L / ' / P / ; move focus to the pane already in that direction,
 * mirroring the Cmd+Alt cluster that *creates* a pane there. Assertions are on
 * the rendered active-pane border (`.explorer-pane.active`) — the cue the user
 * actually sees, and the same `activePaneId` that decides which pane answers
 * arrow keys. Each acceptance-criterion screenshot is taken from the state the
 * assertion above it just pinned, so image and assertion cannot drift apart.
 */

import { test, expect, type Page } from "./fixtures";

const panes = (page: Page) => page.locator(".explorer-pane");
const ACTIVE = /(^|\s)active(\s|$)/;
const INACTIVE = /(^|\s)inactive(\s|$)/;

/** left = /home/user, right = /home (Ctrl+\ seeds the parent); right focused. */
async function sideBySidePanes(page: Page): Promise<void> {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  await page.keyboard.press("Control+\\");
  await expect(panes(page)).toHaveCount(2);
  await expect(panes(page).nth(1)).toHaveClass(ACTIVE);
}

/** top = /home/user, bottom = /home; bottom focused. */
async function stackedPanes(page: Page): Promise<void> {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor({ timeout: 5000 });
  // Cmd/Super+Alt+; splits DOWN and focuses the new pane (#239).
  await page.keyboard.press("Meta+Alt+Semicolon");
  await expect(panes(page)).toHaveCount(2);
  // Send the new bottom pane to the parent directory so the two panes are
  // visually distinguishable in the evidence screenshots.
  await page.keyboard.press("Control+Alt+ArrowUp");
  await expect(
    panes(page).nth(1).locator(".entry-item").filter({ hasText: "user" }).first()
  ).toBeVisible();
  await expect(panes(page).nth(1)).toHaveClass(ACTIVE);
}

test.describe("directional pane focus", () => {
  test("Alt+L moves focus to the pane on the left", async ({ page }) => {
    await sideBySidePanes(page);

    await page.keyboard.press("Alt+l");

    await expect(panes(page).nth(0)).toHaveClass(ACTIVE);
    await expect(panes(page).nth(1)).toHaveClass(INACTIVE);
    // Focus moved; no pane was created (that is what Cmd+Alt+L does).
    await expect(panes(page)).toHaveCount(2);
    await page.screenshot({ path: "evidence/ac-1-alt-l-focus-left.png" });
  });

  test("Alt+' moves focus to the pane on the right", async ({ page }) => {
    await sideBySidePanes(page);
    await page.keyboard.press("Alt+l");
    await expect(panes(page).nth(0)).toHaveClass(ACTIVE);

    await page.keyboard.press("Alt+Quote");

    await expect(panes(page).nth(1)).toHaveClass(ACTIVE);
    await expect(panes(page).nth(0)).toHaveClass(INACTIVE);
    await expect(panes(page)).toHaveCount(2);
    await page.screenshot({ path: "evidence/ac-2-alt-quote-focus-right.png" });
  });

  test("Alt+P moves focus to the pane above", async ({ page }) => {
    await stackedPanes(page);

    await page.keyboard.press("Alt+p");

    await expect(panes(page).nth(0)).toHaveClass(ACTIVE);
    await expect(panes(page).nth(1)).toHaveClass(INACTIVE);
    await expect(panes(page)).toHaveCount(2);
    await page.screenshot({ path: "evidence/ac-3-alt-p-focus-up.png" });
  });

  test("Alt+; moves focus to the pane below", async ({ page }) => {
    await stackedPanes(page);
    await page.keyboard.press("Alt+p");
    await expect(panes(page).nth(0)).toHaveClass(ACTIVE);

    await page.keyboard.press("Alt+Semicolon");

    await expect(panes(page).nth(1)).toHaveClass(ACTIVE);
    await expect(panes(page).nth(0)).toHaveClass(INACTIVE);
    await expect(panes(page)).toHaveCount(2);
    await page.screenshot({ path: "evidence/ac-4-alt-semicolon-focus-down.png" });
  });

  test("a direction with no pane in it is a no-op — focus stays, nothing is created", async ({
    page,
  }) => {
    await sideBySidePanes(page);

    // The right pane is focused in a left|right layout: nothing lies to its
    // right, and a row split has no vertical neighbours at all.
    await page.keyboard.press("Alt+Quote");
    await page.keyboard.press("Alt+p");
    await page.keyboard.press("Alt+Semicolon");

    await expect(panes(page).nth(1)).toHaveClass(ACTIVE);
    await expect(panes(page).nth(0)).toHaveClass(INACTIVE);
    await expect(panes(page)).toHaveCount(2);
    await page.screenshot({ path: "evidence/ac-5-no-neighbour-noop.png" });
  });
});
