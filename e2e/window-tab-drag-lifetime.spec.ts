import { expect, test, type Page } from "./fixtures";

const HOME = "/?path=/home/user";

async function openThreeTabs(page: Page): Promise<void> {
  await page.goto(HOME);
  await page.locator(".entry-item").first().waitFor();
  await page.keyboard.press("Control+t");
  await page.keyboard.press("Control+t");
  await expect(page.locator(".tab")).toHaveCount(3);
  // DOM admission precedes slide-in completion; measure the final hit targets.
  // Motion behavior itself is covered in window-tab-close-lifetime.spec.ts.
  await page.locator(".tab").evaluateAll((tabs) => Promise.all(
    tabs.flatMap((tab) => tab.getAnimations()).map((animation) => animation.finished.catch(() => {})),
  ));
}

async function tabIds(page: Page): Promise<string[]> {
  return page.locator(".tab").evaluateAll((tabs) =>
    tabs.map((tab) => tab.getAttribute("data-tab-id") ?? ""),
  );
}

async function tabCenter(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(".tab").nth(index).boundingBox();
  if (!box) throw new Error(`tab ${index} has no layout box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dispatchTabMouseDown(page: Page, index: number): Promise<void> {
  const point = await tabCenter(page, index);
  await page.locator(".tab").nth(index).dispatchEvent("mousedown", {
    button: 0,
    buttons: 1,
    clientX: point.x,
    clientY: point.y,
  });
}

async function dispatchWindowMouse(
  page: Page,
  type: "mousemove" | "mouseup",
  point: { x: number; y: number },
): Promise<void> {
  await page.evaluate(({ type, point }) => {
    window.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === "mousemove" ? 1 : 0,
      clientX: point.x,
      clientY: point.y,
    }));
  }, { type, point });
}

async function dragTab(page: Page, from: number, to: number): Promise<void> {
  const source = await tabCenter(page, from);
  const target = await tabCenter(page, to);
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await expect(page.locator(".tab").nth(from)).toHaveClass(/dragging/);
  await page.mouse.up();
  await expect(page.locator(".tab-drag-ghost")).toHaveCount(0);
}

test.describe("Window tab pointer-drag lifetime", () => {
  test.beforeEach(async ({ page }) => openThreeTabs(page));

  test("releasing over another tab reorders the visible tabs", async ({ page }) => {
    const before = await tabIds(page);

    await dragTab(page, 0, 2);
    await expect.poll(() => tabIds(page)).toEqual([before[1], before[2], before[0]]);

    // Completion must release the tab incarnation's transfer reservation.
    // Dragging that same tab again would fail to start if the lease leaked.
    await dragTab(page, 2, 0);
    await expect.poll(() => tabIds(page)).toEqual(before);
  });

  test("Escape cancels an active reorder and later mouseup cannot complete it", async ({ page }) => {
    const before = await tabIds(page);
    const activeBefore = await page.locator(".tab.active").getAttribute("data-tab-id");
    const source = await tabCenter(page, 0);
    const target = await tabCenter(page, 2);

    await page.mouse.move(source.x, source.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 4 });
    await expect(page.locator(".tab-drag-ghost")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.up();

    expect(await tabIds(page)).toEqual(before);
    await expect(page.locator(".tab.active")).toHaveAttribute("data-tab-id", activeBefore!);
    await expect(page.locator(".tab-drag-ghost")).toHaveCount(0);
    await expect(page.locator(".tab.dragging")).toHaveCount(0);

    // Cancellation must likewise release the reservation for a later drag.
    await dragTab(page, 0, 2);
    await expect.poll(() => tabIds(page)).toEqual([before[1], before[2], before[0]]);
  });

  test("a replacement drag owns the drop after cancelling the previous drag", async ({ page }) => {
    const before = await tabIds(page);
    const firstTarget = await tabCenter(page, 2);

    await dispatchTabMouseDown(page, 0);
    await dispatchWindowMouse(page, "mousemove", firstTarget);
    await expect(page.locator(".tab").nth(0)).toHaveClass(/dragging/);

    await dispatchTabMouseDown(page, 1);
    const replacementTarget = await tabCenter(page, 2);
    await dispatchWindowMouse(page, "mousemove", replacementTarget);
    await expect(page.locator(".tab").nth(1)).toHaveClass(/dragging/);
    await dispatchWindowMouse(page, "mouseup", replacementTarget);

    await expect.poll(() => tabIds(page)).toEqual([before[0], before[2], before[1]]);
    await expect(page.locator(".tab-drag-ghost")).toHaveCount(0);
  });

  test("unmount removes an active drag ghost and its window listeners", async ({ page }) => {
    // Reduce to one tab, then an unchecked Window Controls setting makes the
    // title bar and its WindowTabBar child unmount.
    await page.locator(".tab-close").nth(2).click();
    await expect(page.locator(".tab")).toHaveCount(2);
    await page.locator(".tab-close").nth(1).click();
    await expect(page.locator(".tab")).toHaveCount(1);

    const start = await tabCenter(page, 0);
    await dispatchTabMouseDown(page, 0);
    await dispatchWindowMouse(page, "mousemove", { x: start.x + 12, y: start.y });
    await expect(page.locator(".tab-drag-ghost")).toBeVisible();

    await page.keyboard.press("Control+,");
    const settings = page.locator(".settings-dialog");
    await expect(settings).toBeVisible();
    const controls = settings.locator(".setting-row", { hasText: "Show Window Controls" });
    await controls.locator('input[type="checkbox"]').evaluate((input) =>
      (input as HTMLInputElement).click(),
    );

    await expect(page.locator(".titlebar")).toHaveCount(0);
    await expect(page.locator(".tab-drag-ghost")).toHaveCount(0);
    await dispatchWindowMouse(page, "mousemove", { x: start.x + 40, y: start.y + 20 });
    await dispatchWindowMouse(page, "mouseup", { x: start.x + 40, y: start.y + 20 });
    await expect(page.locator(".tab-drag-ghost")).toHaveCount(0);
  });
});
