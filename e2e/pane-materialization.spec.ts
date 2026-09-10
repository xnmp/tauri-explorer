import { expect, test, type Page } from "./fixtures";

type PersistedNode =
  | { type: "leaf"; id: string; path: string }
  | {
      type: "split";
      id: string;
      direction: "row" | "column";
      ratio: number;
      first: PersistedNode;
      second: PersistedNode;
    };

const MOCK_DIRS = [
  "/home/user", "/home/user/Archive", "/home/user/my-project", "/home/user/my-project/src",
  "/home/user/Documents", "/home/user/Downloads", "/home/user/Downloads/wrapper",
  "/home/user/Downloads/wrapper/payload", "/home/user/Downloads/wrapper/payload/inner",
  "/home/user/Pictures", "/home/user/Pictures/vacation", "/home/user/Music", "/home/user/Videos",
  "/home/user/Documents/project", "/home/user/Documents/project/src",
  "/home/user/Documents/project/src/components", "/home/user/Documents/project/src/components/Button",
  "/home/user/Documents/project/src/components/Modal", "/home/user/Documents/project/src/components/Sidebar",
  "/home/user/Documents/project/src/utils", "/home/user/Documents/project/src/hooks",
  "/home/user/Documents/project/src/services", "/home/user/Documents/project/src/types",
  "/home/user/Documents/project/src/styles", "/home/user/Documents/project/tests",
  "/home/user/Documents/project/tests/unit", "/home/user/Documents/project/tests/integration",
  "/home/user/Documents/project/tests/e2e", "/home/user/Documents/project/docs",
  "/home/user/Documents/project/scripts", "/home/user/Documents/project/config",
  "/home/user/Documents/project/assets", "/home/user/Documents/project/assets/images",
  "/home/user/Documents/project/assets/fonts", "/home/user/Documents/project/lib",
  "/home/user/Documents/project/lib/core", "/home/user/Documents/project/lib/plugins",
] as const;

function balancedLayout(ids: readonly string[], depth = 0): PersistedNode {
  if (ids.length === 1) {
    const index = Number(ids[0].slice("pane-".length));
    return {
      type: "leaf",
      id: ids[0],
      path: index === 63
        ? "/home/user/Documents/project/src"
        : MOCK_DIRS[index % MOCK_DIRS.length],
    };
  }
  const middle = ids.length / 2;
  return {
    type: "split",
    id: `split-${depth}-${ids[0]}-${ids.at(-1)}`,
    direction: depth % 2 === 0 ? "row" : "column",
    ratio: 0.5,
    first: balancedLayout(ids.slice(0, middle), depth + 1),
    second: balancedLayout(ids.slice(middle), depth + 1),
  };
}

function largeState(prefix = "pane") {
  const paneIds = Array.from({ length: 64 }, (_, index) => `${prefix}-${index}`);
  const layout = balancedLayout(paneIds.map((id, index) =>
    prefix === "pane" ? id : `pane-${index}`,
  ));
  // Give replacement layouts genuinely distinct IDs while retaining the same
  // valid mock paths and balanced shape.
  const rename = (node: PersistedNode): PersistedNode => node.type === "leaf"
    ? { ...node, id: node.id.replace("pane-", `${prefix}-`) }
    : { ...node, id: `${prefix}-${node.id}`, first: rename(node.first), second: rename(node.second) };
  const finalLayout = prefix === "pane" ? layout : rename(layout);
  return {
    version: 3 as const,
    tabs: [{
      id: `${prefix}-tab`,
      kind: "explorer" as const,
      layout: finalLayout,
      activePaneId: `${prefix}-63`,
    }],
    activeTabId: `${prefix}-tab`,
  };
}

async function loadManager(page: Page): Promise<void> {
  await page.goto("/?path=/home/user");
  await page.locator(".entry-item").first().waitFor();
}

test.describe("Large pane materialization", () => {
  test.setTimeout(30_000);

  test("restores the focused pane before paint, bounds initial DOM, then preserves all 64 panes", async ({
    page,
  }, testInfo) => {
    await loadManager(page);
    const state = largeState();

    const initial = await page.evaluate(async (persisted) => {
      const queued = new Map<number, FrameRequestCallback>();
      let nextFrame = 1;
      const nativeRaf = window.requestAnimationFrame.bind(window);
      const nativeCancel = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => {
        const id = nextFrame++;
        queued.set(id, callback);
        return id;
      };
      window.cancelAnimationFrame = (id) => queued.delete(id);

      const loadManagerModule = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const loadSvelte = new Function("return import('/node_modules/svelte/src/index-client.js')");
      const [{ windowTabsManager: manager }, { tick }] = await Promise.all([
        loadManagerModule(), loadSvelte(),
      ]);
      manager.restoreFromState(persisted);
      await tick();
      const result = {
        ready: manager.getAllExplorers().length,
        focusedReady: manager.isPaneReady("pane-63"),
        explorers: document.querySelectorAll(".explorer-pane").length,
        placeholders: document.querySelectorAll(".pane-restoring").length,
        splits: document.querySelectorAll(".pane-split").length,
        queuedFrames: queued.size,
      };
      const firstFrame = [...queued.values()];
      queued.clear();
      window.requestAnimationFrame = nativeRaf;
      window.cancelAnimationFrame = nativeCancel;
      for (const callback of firstFrame) callback(performance.now());
      return result;
    }, state);

    expect(initial).toEqual({
      ready: 1,
      focusedReady: true,
      explorers: 1,
      placeholders: 6,
      splits: 6,
      queuedFrames: 1,
    });
    await expect(page.locator(".explorer-pane.active")).toBeVisible();
    await expect.poll(() => page.evaluate(async () => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const explorer = (await load()).windowTabsManager.getActiveExplorer();
      return {
        path: explorer?.state.currentPath,
        hasApp: explorer?.state.entries.some((entry: { name: string }) => entry.name === "App.tsx"),
      };
    })).toEqual({ path: "/home/user/Documents/project/src", hasApp: true });

    await page.screenshot({
      // Keep generated evidence outside Vite's watched repo root during the
      // run; writing there triggers a full-page reload mid-materialization.
      path: testInfo.outputPath("pane-materialization.png"),
    });

    await expect(page.locator(".explorer-pane")).toHaveCount(64, { timeout: 20_000 });
    await expect(page.locator(".pane-restoring")).toHaveCount(0);
    const finalState = await page.evaluate(async () => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      return (await load()).windowTabsManager.captureState();
    });
    expect(finalState).toEqual(state);
  });

  test("switch and restore cancel obsolete pane activation batches", async ({ page }) => {
    await loadManager(page);
    const large = largeState();
    const smallTab = {
      id: "small-tab",
      kind: "explorer" as const,
      layout: { type: "leaf" as const, id: "small-pane", path: "/home/user/Pictures" },
      activePaneId: "small-pane",
    };
    const twoTabs = { ...large, tabs: [...large.tabs, smallTab] };

    const afterSwitch = await page.evaluate(async (persisted) => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const { windowTabsManager: manager } = await load();
      manager.restoreFromState(persisted);
      manager.setActiveTab("small-tab");
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return {
        oldReady: Array.from({ length: 64 }, (_, index) => manager.isPaneReady(`pane-${index}`)).filter(Boolean).length,
        smallReady: manager.isPaneReady("small-pane"),
      };
    }, twoTabs);
    expect(afterSwitch).toEqual({ oldReady: 1, smallReady: true });
    await expect(page.locator(".explorer-pane .entry-item", { hasText: "photo1.jpg" })).toBeVisible();

    const replacement = largeState("replacement");
    const afterRestore = await page.evaluate(async (persisted) => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const { windowTabsManager: manager } = await load();
      manager.setActiveTab("pane-tab");
      manager.restoreFromState(persisted);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return {
        obsoleteReady: Array.from({ length: 64 }, (_, index) => manager.isPaneReady(`pane-${index}`)).filter(Boolean).length,
        replacementFocused: manager.isPaneReady("replacement-63"),
      };
    }, replacement);
    expect(afterRestore).toEqual({ obsoleteReady: 0, replacementFocused: true });
    await expect.poll(() => page.evaluate(async () => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const explorer = (await load()).windowTabsManager.getActiveExplorer();
      return explorer?.state.entries.some((entry: { name: string }) => entry.name === "App.tsx");
    })).toBe(true);
  });

  test("ordinary folder navigation focuses the selected entry in the new listing", async ({ page }) => {
    await loadManager(page);
    const documents = page.locator('.entry-item[data-path="/home/user/Documents"]');
    await documents.click();
    await expect(documents).toHaveClass(/selected/);
    await documents.dblclick();

    const project = page.locator('.entry-item[data-path="/home/user/Documents/project"]');
    await expect(project).toBeVisible();
    await expect(project).toHaveClass(/selected/);
    await expect.poll(() => page.evaluate(() =>
      document.activeElement?.getAttribute("data-path"),
    )).toBe("/home/user/Documents/project");
  });
});
