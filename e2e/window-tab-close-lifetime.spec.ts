import { expect, test, type Page } from "./fixtures";

const HOME = "/?path=/home/user";

async function openDistinctTabs(page: Page): Promise<void> {
  await page.goto(HOME);
  await page.locator(".entry-item").first().waitFor();
  await page.keyboard.press("Control+t");
  await expect(page.locator(".tab")).toHaveCount(2);
  await page.locator('.entry-item[data-path="/home/user/Documents"]').dblclick();
  await expect(page.locator('.entry-item[data-path="/home/user/Documents/project"]')).toBeVisible();
}

test.describe("Window tab close ownership", () => {
  test("closing the active tab publishes the remaining directory immediately", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openDistinctTabs(page);
    await page.addStyleTag({
      content: "*, *::before, *::after { animation-play-state: paused !important; }",
    });

    // Read the production owner in the same browser task as the DOM click.
    // This distinguishes synchronous publication without a clock-exact wait;
    // the old visual tab may correctly remain in the DOM for its outro.
    const stateAfterClick = await page.locator(".tab.active .tab-close").evaluate(async (button) => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const { windowTabsManager: manager } = await load();
      (button as HTMLButtonElement).click();
      return {
        tabCount: manager.tabs.length,
        activePath: manager.getTabPath(manager.activeTabId),
      };
    });

    expect(stateAfterClick).toEqual({ tabCount: 1, activePath: "/home/user" });
    await expect(
      page.locator('.entry-item[data-path="/home/user/Documents"]'),
    ).toBeVisible();
    await expect(
      page.locator('.entry-item[data-path="/home/user/Documents/project"]'),
    ).toHaveCount(0, { timeout: 100 });
  });

  test("an old close animation cannot delete a restored same-ID tab", async ({ page }) => {
    await openDistinctTabs(page);
    const activeId = await page.locator(".tab.active").getAttribute("data-tab-id");
    expect(activeId).not.toBeNull();

    const persisted = await page.evaluate(async () => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const { windowTabsManager: manager } = await load();
      return {
        version: 3,
        tabs: manager.tabs.map((tab: { id: string }) => manager.exportTab(tab.id)?.tab),
        activeTabId: manager.activeTabId,
      };
    });

    // Schedule the component's visual close, then replace the manager state
    // with a valid persisted workspace containing the same stable tab ID.
    await page.locator(".tab.active .tab-close").evaluate((button) =>
      (button as HTMLButtonElement).click(),
    );
    await page.evaluate(async ({ id, state }) => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const { windowTabsManager: manager } = await load();
      manager.closeTab(id);
      manager.restoreFromState(state);
    }, { id: activeId!, state: persisted });

    await expect(page.locator(`.tab[data-tab-id="${activeId}"]`)).toHaveCount(1);
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/project"]')).toBeVisible();

    // The old implementation's delayed callback fires at 200 ms and targets
    // only the stable ID, so it removes the replacement incarnation here.
    await page.waitForTimeout(260);
    await expect(page.locator(`.tab[data-tab-id="${activeId}"]`)).toHaveCount(1);
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/project"]')).toBeVisible();
  });

  test("outro is contextual, skips initial mount, and allows rapid undo", async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.addInitScript(() => {
      const records: Array<{ duration: number; firstOpacity: string | null }> = [];
      Object.defineProperty(window, "__initialTabAnimations", { value: records });
      window.addEventListener("DOMContentLoaded", () => {
        const seen = new WeakSet<Animation>();
        const sample = () => {
          for (const tab of document.querySelectorAll(".tab")) {
            for (const animation of tab.getAnimations()) {
              if (seen.has(animation)) continue;
              seen.add(animation);
              const frames = animation.effect instanceof KeyframeEffect
                ? animation.effect.getKeyframes()
                : [];
              records.push({
                duration: Number(animation.effect?.getComputedTiming().duration),
                firstOpacity: frames[0]?.opacity?.toString() ?? null,
              });
            }
          }
        };
        const interval = window.setInterval(sample, 8);
        window.setTimeout(() => {
          sample();
          window.clearInterval(interval);
        }, 500);
      }, { once: true });
    });

    await page.goto(HOME);
    await page.locator(".entry-item").first().waitFor();
    await page.waitForTimeout(520);
    const initialAnimations = await page.evaluate(() =>
      (window as unknown as {
        __initialTabAnimations: Array<{ duration: number; firstOpacity: string | null }>;
      }).__initialTabAnimations,
    );
    expect(initialAnimations).toHaveLength(0);

    await page.keyboard.press("Control+t");
    await page.locator('.entry-item[data-path="/home/user/Documents"]').dblclick();
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/project"]')).toBeVisible();

    await page.locator(".tab.active .tab-close").click();
    await expect(page.locator('.entry-item[data-path="/home/user/Documents"]')).toBeVisible();
    const slowed = await page.locator(".tab-area").evaluate((bar) => {
      const animations = bar.getAnimations({ subtree: true }).filter((animation) =>
        animation.playState === "running",
      );
      for (const animation of animations) animation.playbackRate = 0.1;
      return animations.length;
    });
    expect(slowed).toBeGreaterThan(0);

    if (testInfo.project.name === "chromium") {
      await page.waitForTimeout(80);
      await page.screenshot({
        path: "screenshots/refactor/repo-health-cleanup/tab-close-lifetime.png",
      });
    }

    await page.keyboard.press("Control+Shift+t");
    await expect(page.locator(".tab")).toHaveCount(2);
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/project"]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
