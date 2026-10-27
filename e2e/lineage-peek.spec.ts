/**
 * Lineage peek (#1431): a provider's lineage groups each file's edits under
 * it in Details through Folder Peek. A + B were merged into m; A was edited
 * into c and d.
 */
import { expect, test, type Page } from "./fixtures";
import { waitForEntries, HOME_URL } from "./helpers";

const root = "/lineage-peek";
const P = (name: string) => `${root}/${name}`;
const pane = ".pane-tree:not(.retained)";
const rows = (page: Page, name: string) => page.locator(`${pane} .entry-item[data-path="${P(name)}"]`);
const LINEAGE = { "c.png": ["A.png"], "d.png": ["A.png"], "m.png": ["A.png", "B.png"] };

async function start(page: Page, mode: "details" | "list" | "tiles" = "details", options: { delay?: number } = {}) {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(async ({ root, lineage, mode, delay }) => {
    const { mockFiles } = await import("/src/lib/api/mock-fixtures.ts");
    const at = Date.UTC(2026, 0, 1);
    const file = (name: string, size = 4096) => ({ name, path: `${root}/${name}`, kind: "file" as const, size, modified: new Date(at).toISOString() });
    mockFiles[root] = ["A.png", "B.png", "c.png", "d.png", "m.png", "notes.txt"].map(name => file(name));
    const provider = await import("/src/test-support/lineage-provider.ts");
    provider.install(root, lineage, { delay });
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const explorer = windowTabsManager.getActiveExplorer()!;
    explorer.setViewMode(mode);
    await explorer.navigateTo(root, { autoEnterSingleSubdir: false });
  }, { root, lineage: LINEAGE, mode, delay: options.delay ?? 0 });
}

async function explorerCall(page: Page, method: "selectWithEdits" | "collapseAllPeeks") {
  await page.evaluate(async method => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    await windowTabsManager.getActiveExplorer()![method]();
  }, method);
}

const level = (locator: ReturnType<Page["locator"]>) => locator.locator("xpath=..").getAttribute("aria-level");

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => (await import("/src/test-support/lineage-provider.ts")).uninstall()).catch(() => {});
});

test("groups edits under their parents, with a merge output under each parent", async ({ page }) => {
  await start(page);
  // Depth 0 holds the roots and ordinary files only.
  await expect(rows(page, "A.png")).toBeVisible();
  await expect(rows(page, "notes.txt")).toBeVisible();
  await expect(rows(page, "c.png")).toHaveCount(0);
  await expect(rows(page, "m.png")).toHaveCount(0);

  await rows(page, "A.png").getByRole("button", { name: "Expand A.png", exact: true }).click();
  const groupOfA = page.locator(`${pane} [data-lineage-group="group:${P("A.png")}|${P("B.png")}"]`);
  await expect(groupOfA).toBeVisible();
  await expect(groupOfA).toContainText("with B.png");
  await expect(rows(page, "c.png")).toBeVisible();
  expect(await level(rows(page, "c.png"))).toBe("2");
  // A's group opens with A: m sits beneath it, one level deeper.
  await expect(rows(page, "m.png")).toHaveCount(1);
  expect(await level(rows(page, "m.png"))).toBe("3");

  await rows(page, "B.png").getByRole("button", { name: "Expand B.png", exact: true }).click();
  await expect(page.locator(`${pane} [data-lineage-group="group:${P("B.png")}|${P("A.png")}"]`)).toContainText("with A.png");
  await expect(rows(page, "m.png")).toHaveCount(2);

  // Group rows come before direct children, and are not files.
  const order = await page.locator(`${pane} [role="row"]`).evaluateAll(elements => elements.map(element =>
    element.querySelector("[data-lineage-group]")?.textContent?.trim().replace(/\s+/g, " ")
    ?? element.querySelector(".entry-item")?.getAttribute("data-path")?.split("/").pop()));
  expect(order).toEqual(["A.png", "with B.png 1", "m.png", "c.png", "d.png", "B.png", "with A.png 1", "m.png", "notes.txt"]);

  // Selecting one occurrence highlights both; the status bar counts the file once.
  await rows(page, "m.png").nth(1).click();
  await expect(rows(page, "m.png").nth(0)).toHaveClass(/selected/);
  await expect(rows(page, "m.png").nth(1)).toHaveClass(/selected/);
  const selected = await page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.getSelectedEntries().map(entry => entry.name));
  expect(selected).toEqual(["m.png"]);
  // The cursor is the clicked (second) occurrence: only it is the tab stop.
  await expect(rows(page, "m.png").nth(1)).toHaveAttribute("tabindex", "0");
  await expect(rows(page, "m.png").nth(0)).toHaveAttribute("tabindex", "-1");
  await page.screenshot({ path: "screenshots/feat/lineage-peek/details-lineage.png" });

  // Collapsing B keeps the other occurrence selected (a path stays while any occurrence shows).
  await rows(page, "B.png").getByRole("button", { name: "Collapse B.png", exact: true }).click();
  await expect(rows(page, "m.png")).toHaveCount(1);
  await expect(rows(page, "m.png")).toHaveClass(/selected/);
  // A group row is not a file: clicking it toggles it and previews the parents it combines.
  await groupOfA.click();
  await expect(rows(page, "m.png")).toHaveCount(0);
  const target = await page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.previewTarget?.target);
  expect(target?.details).toEqual([{ label: "Parents", value: "A.png, B.png" }, { label: "Files", value: "1" }]);
});

test("Shift ranges follow the visible occurrences and skip group rows", async ({ page }) => {
  await start(page);
  await rows(page, "A.png").getByRole("button", { name: "Expand A.png", exact: true }).click();
  await rows(page, "B.png").getByRole("button", { name: "Expand B.png", exact: true }).click();
  await rows(page, "m.png").nth(1).click();
  await rows(page, "notes.txt").click({ modifiers: ["Shift"] });
  const selected = await page.evaluate(async () => [...(await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.selectedPaths].sort());
  // From B's m down to notes: not A's children above.
  expect(selected).toEqual([P("m.png"), P("notes.txt")]);
  // ArrowUp from B's m walks to B (past the group row), not to A's m.
  await rows(page, "m.png").nth(1).click();
  await page.keyboard.press("ArrowUp");
  await expect(rows(page, "B.png")).toHaveClass(/selected/);
});

test("a name filter suspends grouping and matches show flat", async ({ page }) => {
  await start(page);
  await expect(rows(page, "m.png")).toHaveCount(0);
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const explorer = windowTabsManager.getActiveExplorer()!;
    explorer.openFilter(); explorer.setFilter("m.");
  });
  await expect(rows(page, "m.png")).toHaveCount(1);
  expect(await level(rows(page, "m.png"))).toBe("1");
  await page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.closeFilter());
  await expect(rows(page, "m.png")).toHaveCount(0);
  await expect(rows(page, "A.png")).toBeVisible();
});

test("a new edit is held until the lineage knows it, never flashing at depth 0", async ({ page }) => {
  await start(page);
  await rows(page, "A.png").getByRole("button", { name: "Expand A.png", exact: true }).click();
  await expect(rows(page, "c.png")).toBeVisible();
  // Record every frame in which the new file is a depth-0 row.
  await page.evaluate(path => {
    const seen: string[] = [];
    (window as unknown as { __rootFlash: string[] }).__rootFlash = seen;
    const check = () => {
      const row = document.querySelector(`.pane-tree:not(.retained) .entry-item[data-path="${path}"]`);
      if (row && row.parentElement?.getAttribute("aria-level") === "1") seen.push("depth0");
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }, P("n.png"));
  await page.evaluate(async ({ root }) => {
    const { mockFiles } = await import("/src/lib/api/mock-fixtures.ts");
    mockFiles[root] = [...mockFiles[root], { name: "n.png", path: `${root}/n.png`, kind: "file", size: 4096, modified: new Date().toISOString() }];
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    await windowTabsManager.getActiveExplorer()!.refresh({ silent: true });
    // The provider learns of the edit a little later, then signals `changed`.
    setTimeout(async () => (await import("/src/test-support/lineage-provider.ts")).update({
      "c.png": ["A.png"], "d.png": ["A.png"], "m.png": ["A.png", "B.png"], "n.png": ["A.png"],
    }), 120);
  }, { root });
  await expect(rows(page, "n.png")).toBeVisible();
  expect(await level(rows(page, "n.png"))).toBe("2");
  expect(await page.evaluate(() => (window as unknown as { __rootFlash: string[] }).__rootFlash)).toEqual([]);
});

test("an unknown arrival appears at depth 0 once the hold expires", async ({ page }) => {
  await start(page);
  await page.evaluate(async ({ root }) => {
    const { mockFiles } = await import("/src/lib/api/mock-fixtures.ts");
    mockFiles[root] = [...mockFiles[root], { name: "plain.txt", path: `${root}/plain.txt`, kind: "file", size: 1, modified: new Date().toISOString() }];
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    await windowTabsManager.getActiveExplorer()!.refresh({ silent: true });
  }, { root });
  await expect(rows(page, "plain.txt")).toBeVisible();
  expect(await level(rows(page, "plain.txt"))).toBe("1");
});

test("Select with Edits opens and selects every lineage descendant", async ({ page }) => {
  await start(page);
  await rows(page, "A.png").click();
  await explorerCall(page, "selectWithEdits");
  const selected = await page.evaluate(async () => [...(await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.selectedPaths].sort());
  expect(selected).toEqual(["A.png", "c.png", "d.png", "m.png"].map(P));
  for (const name of ["c.png", "d.png", "m.png"]) await expect(rows(page, name).first()).toHaveClass(/selected/);
  // Ctrl+A stays at depth 0.
  await page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.selectAll());
  const all = await page.evaluate(async () => [...(await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.selectedPaths].sort());
  expect(all).toEqual(["A.png", "B.png", "notes.txt"].map(P));
});

test("the View menu's Show traces turns grouping off for the pane", async ({ page }) => {
  await start(page);
  await expect(rows(page, "c.png")).toHaveCount(0);
  await page.locator(`${pane} .file-list .content`).click({ button: "right", position: { x: 400, y: 330 } });
  const option = page.getByRole("menuitemcheckbox", { name: "Show traces" });
  await expect(option).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: "screenshots/feat/lineage-peek/view-menu-show-traces.png" });
  await option.click();
  await expect(rows(page, "c.png")).toBeVisible();
  expect(await level(rows(page, "m.png"))).toBe("1");
  expect(await page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.lineageHidden)).toEqual(["e2e.lineage"]);
});

test("first paint waits for a slow lineage instead of showing a flat listing", async ({ page }) => {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(path => {
    const seen: string[] = [];
    (window as unknown as { __flat: string[] }).__flat = seen;
    const check = () => {
      if (document.querySelector(`.pane-tree:not(.retained) .entry-item[data-path="${path}"]`)) seen.push("flat");
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }, P("c.png"));
  await page.evaluate(async ({ root, lineage }) => {
    const { mockFiles } = await import("/src/lib/api/mock-fixtures.ts");
    const file = (name: string) => ({ name, path: `${root}/${name}`, kind: "file" as const, size: 1, modified: new Date().toISOString() });
    mockFiles[root] = ["A.png", "B.png", "c.png", "d.png", "m.png"].map(file);
    (await import("/src/test-support/lineage-provider.ts")).install(root, lineage, { delay: 150 });
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const explorer = windowTabsManager.getActiveExplorer()!;
    explorer.setViewMode("details");
    await explorer.navigateTo(root, { autoEnterSingleSubdir: false });
  }, { root, lineage: LINEAGE });
  await expect(rows(page, "A.png")).toBeVisible();
  await expect(rows(page, "c.png")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __flat: string[] }).__flat)).toEqual([]);
});

test("List shows an open lineage as a card with its group row", async ({ page }) => {
  await start(page, "list");
  await rows(page, "A.png").getByRole("button", { name: "Expand A.png", exact: true }).click();
  const card = page.locator(`${pane} [data-card-scroll][data-path="${P("A.png")}"]`);
  await expect(card.locator(`[data-lineage-group="group:${P("A.png")}|${P("B.png")}"]`)).toContainText("with B.png");
  for (const name of ["m.png", "c.png", "d.png"]) await expect(card.locator(`.entry-item[data-path="${P(name)}"]`)).toBeVisible();
  await page.screenshot({ path: "screenshots/feat/lineage-peek/list-lineage-card.png" });
});

test("Tiles opens lineage panels, and spatial keys keep each duplicate's own panel", async ({ page }) => {
  await start(page, "tiles");
  const tile = (name: string) => page.locator(`${pane} .tile-row .entry-item[data-path="${P(name)}"]`);
  await tile("A.png").getByRole("button", { name: "Expand A.png", exact: true }).click();
  await tile("B.png").getByRole("button", { name: "Expand B.png", exact: true }).click();
  const panelOf = (name: string) => page.locator(`${pane} .tile-panel[data-path="${P(name)}"]`);
  await expect(panelOf("A.png").locator(`.entry-item[data-path="${P("m.png")}"]`)).toBeVisible();
  await expect(panelOf("B.png").locator(`.entry-item[data-path="${P("m.png")}"]`)).toBeVisible();
  await page.screenshot({ path: "screenshots/feat/lineage-peek/tiles-lineage-panels.png" });
  const focusedPanel = () => page.evaluate(() => document.activeElement?.closest(".tile-panel")?.getAttribute("data-path") ?? null);
  // A's panel takes the band below the row, so B's opens above it.
  for (const [name, key] of [["A.png", "ArrowDown"], ["B.png", "ArrowUp"]] as const) {
    await tile(name).click();
    await page.keyboard.press(key);
    await expect.poll(focusedPanel).toBe(P(name));
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.path)).toBe(P("m.png"));
    // Both occurrences of m highlight, but the cursor is this panel's.
    await expect(page.locator(`${pane} .tile-panel .entry-item.selected[data-path="${P("m.png")}"]`)).toHaveCount(2);
  }
});
