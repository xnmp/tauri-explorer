import { expect, test, type Page } from "./fixtures";

const splitTab = {
  id: "resize-tab",
  kind: "explorer" as const,
  activePaneId: "resize-left",
  layout: {
    type: "split" as const,
    id: "resize-divider",
    direction: "row" as const,
    ratio: 0.5,
    first: { type: "leaf" as const, id: "resize-left", path: "/home/user" },
    second: { type: "leaf" as const, id: "resize-right", path: "/home/user/Documents" },
  },
};

const state = { version: 3 as const, tabs: [splitTab], activeTabId: splitTab.id };

async function restore(page: Page, value: unknown = state): Promise<void> {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor();
  await page.evaluate(async (persisted) => {
    const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
    (await load()).windowTabsManager.restoreFromState(persisted);
  }, value);
  await expect(page.locator(".explorer-pane")).toHaveCount(
    (value as { tabs: Array<{ id: string }> }).tabs[0].id === splitTab.id ? 2 : 1,
  );
}

async function ratio(page: Page, tabId = splitTab.id): Promise<number> {
  return page.evaluate(async (id) => {
    const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
    const tab = (await load()).windowTabsManager.captureState().tabs.find(
      (candidate: { id: string }) => candidate.id === id,
    );
    return tab?.layout.ratio;
  }, tabId);
}

async function dividerGeometry(page: Page) {
  const split = await page.locator(".pane-split.row").boundingBox();
  const divider = await page.locator(".pane-divider").boundingBox();
  const first = await page.locator(".split-child.first").boundingBox();
  const second = await page.locator(".split-child.second").boundingBox();
  if (!split || !divider || !first || !second) throw new Error("split geometry unavailable");
  return { split, divider, first, second };
}

async function beginQueuedMove(page: Page, fraction: number): Promise<void> {
  const { split, divider } = await dividerGeometry(page);
  const y = divider.y + divider.height / 2;
  await page.mouse.move(divider.x + divider.width / 2, y);
  await page.mouse.down();
  // This leaves the narrow divider. Pointer capture must continue routing the
  // gesture to its owner while the frame is queued.
  await page.mouse.move(split.x + split.width * fraction, y);
  await expect(page.locator(".pane-split.resizing")).toHaveCount(1);
}

async function armPointerIdCapture(page: Page): Promise<void> {
  await page.locator(".pane-divider").evaluate((divider) => {
    divider.addEventListener("pointerdown", (event) => {
      document.documentElement.dataset.resizePointerId = String(event.pointerId);
    }, {
      capture: true,
      once: true,
    });
  });
}

async function capturedPointerId(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.documentElement.dataset.resizePointerId));
}

async function installFrameControl(page: Page): Promise<void> {
  await page.evaluate(() => {
    const callbacks: FrameRequestCallback[] = [];
    const nativeRaf = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    let next = 1;
    Object.defineProperty(window, "__paneResizeFrames", {
      configurable: true,
      value: {
        callbacks,
        nativeRaf,
        nativeCancel,
        restore() {
          window.requestAnimationFrame = nativeRaf;
          window.cancelAnimationFrame = nativeCancel;
        },
      },
    });
    window.requestAnimationFrame = (callback) => {
      callbacks.push(callback);
      return next++;
    };
    // Preserve callbacks even when cancellation succeeds, so tests can invoke
    // a hostile late frame after the owner has unmounted.
    window.cancelAnimationFrame = () => {};
  });
}

async function flushCapturedFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (window as unknown as {
      __paneResizeFrames: {
        callbacks: FrameRequestCallback[];
        restore(): void;
      };
    }).__paneResizeFrames;
    const callbacks = control.callbacks.splice(0);
    control.restore();
    for (const callback of callbacks) callback(performance.now());
  });
}

test.describe("Pane resize lifetime", () => {
  test("real divider drag changes pane geometry and persists its ratio", async ({ page }, testInfo) => {
    await restore(page);
    const before = await dividerGeometry(page);
    const startX = before.divider.x + before.divider.width / 2;
    const y = before.divider.y + before.divider.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + 140, y, { steps: 5 });
    await page.mouse.up();

    const after = await dividerGeometry(page);
    expect(after.first.width).toBeGreaterThan(before.first.width + 100);
    expect(after.second.width).toBeLessThan(before.second.width - 100);
    expect(await ratio(page)).toBeGreaterThan(0.6);
    await expect(page.locator(".explorer-pane").first().locator(".entry-item", { hasText: "Documents" })).toBeVisible();
    await expect(page.locator(".explorer-pane").nth(1).locator(".entry-item", { hasText: "project" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("pane-resize.png") });
  });

  test("a queued frame cannot resize a restored same-ID tab", async ({ page }) => {
    await restore(page);
    await installFrameControl(page);
    await beginQueuedMove(page, 0.8);

    const replacement = {
      ...state,
      tabs: [{ ...splitTab, layout: { ...splitTab.layout, ratio: 0.3 } }],
    };
    await page.evaluate(async (persisted) => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      (await load()).windowTabsManager.restoreFromState(persisted);
    }, replacement);
    await flushCapturedFrames(page);
    await page.mouse.up();

    expect(await ratio(page)).toBe(0.3);
    await expect(page.locator(".pane-split.resizing")).toHaveCount(0);
    const geometry = await dividerGeometry(page);
    expect(geometry.first.width).toBeLessThan(geometry.second.width);
  });

  test("tab switch unmounts a pending resize without changing either tab", async ({ page }) => {
    const other = {
      id: "other-tab",
      kind: "explorer" as const,
      activePaneId: "other-pane",
      layout: { type: "leaf" as const, id: "other-pane", path: "/home/user/Pictures" },
    };
    await restore(page, { version: 3, tabs: [splitTab, other], activeTabId: splitTab.id });
    await installFrameControl(page);
    await beginQueuedMove(page, 0.8);
    await page.evaluate(async () => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      (await load()).windowTabsManager.setActiveTab("other-tab");
    });
    await flushCapturedFrames(page);
    await page.mouse.up();

    await expect(page.locator(".pane-split")).toHaveCount(0);
    await expect(page.locator(".explorer-pane .entry-item", { hasText: "photo1.jpg" })).toBeVisible();
    expect(await ratio(page)).toBe(0.5);
  });

  test("window blur cancels a queued resize", async ({ page }) => {
    await restore(page);
    await installFrameControl(page);
    await beginQueuedMove(page, 0.8);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await flushCapturedFrames(page);
    await page.mouse.up();

    expect(await ratio(page)).toBe(0.5);
    await expect(page.locator(".pane-split.resizing")).toHaveCount(0);
  });

  test("captured drag continues outside the divider and release makes later hover inert", async ({ page }) => {
    await restore(page);
    const { split, divider } = await dividerGeometry(page);
    const y = divider.y + divider.height / 2;
    await page.mouse.move(divider.x + divider.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(split.x + split.width * 0.72, y, { steps: 3 });
    await page.mouse.up();

    const committed = await ratio(page);
    expect(committed).toBeGreaterThan(0.65);
    await expect(page.locator(".pane-split.resizing")).toHaveCount(0);

    await page.mouse.move(split.x + split.width * 0.28, y, { steps: 3 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(await ratio(page)).toBe(committed);
    await expect(page.locator(".explorer-pane").nth(1).locator(".entry-item", { hasText: "project" })).toBeVisible();
  });

  test("pointer cancellation drops a queued frame", async ({ page }) => {
    await restore(page);
    await installFrameControl(page);
    await armPointerIdCapture(page);
    await beginQueuedMove(page, 0.8);
    const pointerId = await capturedPointerId(page);
    await page.locator(".pane-divider").dispatchEvent("pointercancel", {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerId,
      pointerType: "mouse",
    });
    await flushCapturedFrames(page);
    await page.mouse.up();

    expect(await ratio(page)).toBe(0.5);
    await expect(page.locator(".pane-split.resizing")).toHaveCount(0);
  });

  test("a lost pointer capture event drops a queued frame", async ({ page }) => {
    await restore(page);
    await installFrameControl(page);
    await armPointerIdCapture(page);
    await beginQueuedMove(page, 0.8);
    const pointerId = await capturedPointerId(page);
    const wasCaptured = await page.locator(".pane-divider").evaluate((divider, id) => {
      if (!divider.hasPointerCapture(id)) return false;
      divider.dispatchEvent(new PointerEvent("lostpointercapture", {
        bubbles: true,
        isPrimary: true,
        pointerId: id,
        pointerType: "mouse",
      }));
      return true;
    }, pointerId);
    expect(wasCaptured).toBe(true);
    await expect(page.locator(".pane-split.resizing")).toHaveCount(0);
    await flushCapturedFrames(page);
    await page.mouse.up();

    expect(await ratio(page)).toBe(0.5);
  });
});
