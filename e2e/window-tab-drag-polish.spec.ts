/**
 * Window tab strip polish (#1749): live drag displacement with an insertion
 * position, the tab context menu, and right-neighbour activation on close.
 */
import { expect, test, type Page } from "./fixtures";

const SHOTS = "screenshots/feat/tab-drag-polish";

async function openFourTabs(page: Page): Promise<string[]> {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor();
  for (let i = 0; i < 3; i++) await page.keyboard.press("Control+t");
  await expect(page.locator(".tab")).toHaveCount(4);
  for (const tab of await page.locator(".tab").all()) await tab.click({ trial: true });
  return tabIds(page);
}

function tabIds(page: Page): Promise<string[]> {
  return page.locator(".tab").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-tab-id") ?? ""));
}

async function center(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = (await page.locator(".tab").nth(index).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A tab's settled horizontal translation (CSS px). */
function shiftOf(page: Page, index: number): Promise<number> {
  return page.locator(".tab").nth(index).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
}

test("dragging a tab moves the others aside live, then drops it at the shown position", async ({ page }) => {
  const before = await openFourTabs(page);
  // The active (last) tab is dragged: it must dim like any other (#1749).
  await expect(page.locator(".tab").nth(3)).toHaveClass(/active/);
  const source = await center(page, 3);
  const target = await center(page, 1);

  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 8 });

  const list = page.locator(".tab-list");
  await expect(list).toHaveClass(/reordering/);
  await expect(list).toHaveAttribute("data-reorder-to", "1");
  const dragged = page.locator(".tab").nth(3);
  await expect(dragged).toHaveClass(/dragging/);
  await expect.poll(() => dragged.evaluate((el) => getComputedStyle(el).opacity)).toBe("0.5");
  // Tabs 1 and 2 make room; tab 0 stays; the dragged tab stands in the gap.
  await expect.poll(() => shiftOf(page, 1)).toBeGreaterThan(20);
  await expect.poll(() => shiftOf(page, 2)).toBeGreaterThan(20);
  expect(await shiftOf(page, 0)).toBe(0);
  await expect.poll(() => shiftOf(page, 3)).toBeLessThan(-40);
  // The ghost carries the tab's icon as well as its title.
  await expect(page.locator(".tab-drag-ghost .tab-drag-ghost-icon")).toHaveCount(1);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/drag-reorder-displacement.png`, clip: { x: 0, y: 0, width: 1280, height: 140 } });

  await page.mouse.up();
  await expect.poll(() => tabIds(page)).toEqual([before[0], before[3], before[1], before[2]]);
  await expect(page.locator(".tab-drag-ghost")).toHaveCount(0);
  await expect(list).not.toHaveClass(/reordering/);
  await expect(page.locator(".tab.dragging")).toHaveCount(0);
});

test("moving back to the source slot clears the displacement and Escape restores the order", async ({ page }) => {
  const before = await openFourTabs(page);
  const source = await center(page, 0);
  const far = await center(page, 3);
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(far.x, far.y, { steps: 6 });
  await expect(page.locator(".tab-list")).toHaveAttribute("data-reorder-to", "3");
  await page.mouse.move(source.x, source.y, { steps: 6 });
  await expect(page.locator(".tab-list")).toHaveAttribute("data-reorder-to", "0");
  await expect.poll(() => shiftOf(page, 2)).toBe(0);
  await page.mouse.move(far.x, far.y, { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await tabIds(page)).toEqual(before);
  await expect(page.locator(".tab-list")).not.toHaveClass(/reordering/);
});

test("tab context menu: Close Others leaves only the clicked tab", async ({ page }) => {
  const before = await openFourTabs(page);
  await page.locator(".tab").nth(1).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Tab actions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText(["Close", "Close Others", "Close to the Right", "Duplicate", "Reopen Closed Tab"]);
  await expect(menu.getByRole("menuitem", { name: "Reopen Closed Tab" })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/tab-context-menu.png`, clip: { x: 0, y: 0, width: 1280, height: 320 }, animations: "disabled" });

  await menu.getByRole("menuitem", { name: "Close Others" }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => tabIds(page)).toEqual([before[1]]);
  await expect(page.locator(".tab.active")).toHaveAttribute("data-tab-id", before[1]);

  // Every closed tab is restorable from the same menu.
  await page.locator(".tab").first().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Reopen Closed Tab" }).click();
  await expect(page.locator(".tab")).toHaveCount(2);
});

test("tab context menu: Close to the Right, Duplicate and Escape", async ({ page }) => {
  const before = await openFourTabs(page);
  const menu = page.getByRole("menu", { name: "Tab actions" });

  await page.locator(".tab").nth(1).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Close to the Right" }).click();
  await expect.poll(() => tabIds(page)).toEqual([before[0], before[1]]);
  await expect(page.locator(".tab.active")).toHaveAttribute("data-tab-id", before[1]);

  await page.locator(".tab").nth(0).click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.locator(".tab")).toHaveCount(3);
  const after = await tabIds(page);
  expect(after[0]).toBe(before[0]);
  expect(after[2]).toBe(before[1]);
  await expect(page.locator(".tab.active")).toHaveAttribute("data-tab-id", after[1]);
  await expect(page.locator(".tab").nth(1)).toHaveAttribute("title", (await page.locator(".tab").nth(0).getAttribute("title"))!);

  await page.locator(".tab").nth(2).click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.locator(".tab")).toHaveCount(3);
});

test("closing the active middle tab activates its right neighbour", async ({ page }) => {
  const before = await openFourTabs(page);
  await page.locator(".tab").nth(1).click();
  await expect(page.locator(".tab.active")).toHaveAttribute("data-tab-id", before[1]);
  await page.locator(".tab").nth(1).locator(".tab-close").click();
  await expect.poll(() => tabIds(page)).toEqual([before[0], before[2], before[3]]);
  await expect(page.locator(".tab.active")).toHaveAttribute("data-tab-id", before[2]);
});
