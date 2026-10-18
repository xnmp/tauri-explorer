import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./fixtures";
import { colorDistance, decodePng } from "./png-pixels";

// Tiles panels (#1241, spec §9): an open top-level folder shows its contents
// in a panel in a band below or above its grid row, or stacked under the row.
// Folders sort first: AI Draft Archive(0) Archive(1) Career(2) Codex(3)
// Inbox(4) Personal(5); small tiles at 900px give 7 columns.
const root = "/folder-peek-tiles";
const shown = ".pane-tree:not(.retained)";
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (/derived_inert|effect_update_depth|state_unsafe_mutation/.test(message.text())) errors.push(message.text()); });
});
test.afterEach(async ({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });

const P = (name: string, base = root) => `${base}/${name}`;
const scroller = (page: Page) => page.locator(`${shown} .tiles-scroller`);
const tile = (page: Page, path: string) => page.locator(`${shown} .tile-row .entry-item[data-path="${path}"]`);
const caret = (page: Page, path: string) => tile(page, path).locator(".peek-caret");
const panel = (page: Page, path: string) => page.locator(`${shown} .tile-panel[data-path="${path}"]`);
const mini = (page: Page, path: string) => page.locator(`${shown} .tile-panel .entry-item[data-path="${path}"]`);
/** The drop-target state class itself (not the .peek-drop-target identity class). */
const targeted = /(^|\s)drop-target(\s|$)/;

async function open(page: Page, base = root, size = { width: 900, height: 800 }) {
  await page.setViewportSize(size);
  await page.goto(`/?path=${base}&viewMode=tiles`);
  await expect(page.locator(`${shown} .tile-row .entry-item`).first()).toBeVisible();
  return columns(page);
}
const columns = async (page: Page) => Number(await page.locator(`${shown} .tiles-view`).getAttribute("data-columns"));
const setting = (page: Page, patch: Record<string, unknown>) => page.evaluate(async values => {
  const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
  settingsStore.update(values);
}, patch);
const explorerCall = <T>(page: Page, body: string, arg?: unknown) => page.evaluate(async ([source, value]) => {
  const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
  return new Function("explorer", "value", source)(windowTabsManager.getActiveExplorer()!, value);
}, [body, arg] as const) as Promise<T>;

/** Panel rects, group heights and ghosts: unchanged across 200ms once motion has ended. */
const layoutSignature = (page: Page) => page.evaluate(selector => {
  const pane = document.querySelector(selector)!;
  const rects = [...pane.querySelectorAll<HTMLElement>(".tile-panel")].map(el => {
    const r = el.getBoundingClientRect();
    return `${el.dataset.path}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}:${el.style.opacity}`;
  });
  const groups = [...pane.querySelectorAll<HTMLElement>(".tiles-scroller .virtual-item")].map(el => el.style.height);
  return JSON.stringify({ rects, groups, ghosts: pane.querySelectorAll(".tile-panel-ghost").length, top: pane.querySelector(".tiles-scroller")!.scrollTop });
}, shown);
async function settled(page: Page) {
  let previous = "";
  await expect.poll(async () => {
    const now = await layoutSignature(page);
    const stable = now === previous && !now.includes('"ghosts":1') && JSON.parse(now).ghosts === 0;
    previous = now;
    return stable;
  }, { timeout: 5000, intervals: [200] }).toBe(true);
}
/** Clicks a folder's caret and waits until its panel has settled. */
async function toggle(page: Page, path: string) {
  const wasOpen = await caret(page, path).getAttribute("aria-expanded") === "true";
  await caret(page, path).click();
  await expect(caret(page, path)).toHaveAttribute("aria-expanded", String(!wasOpen));
  await expect(panel(page, path)).toHaveCount(wasOpen ? 0 : 1);
  await expect.poll(() => explorerCall<string>(page, "return explorer.peekStatus(value) ?? 'none'", path)).not.toBe("loading");
  await settled(page);
}
/** Where a panel sits relative to its parent tile, measured. */
async function side(page: Page, path: string): Promise<string> {
  const [box, parent] = await Promise.all([panel(page, path).boundingBox(), tile(page, path).boundingBox()]);
  if (!box || !parent) return "none";
  if (box.y + box.height <= parent.y) return "above";
  const label = await panel(page, path).locator(".tile-panel-label").count();
  return label ? "stacked" : "below";
}
const rect = async (page: Page, path: string) => (await panel(page, path).boundingBox())!;

test("opens below, then above, then stacked; opening never moves an existing panel", async ({ page }) => {
  expect(await open(page)).toBe(7);
  await toggle(page, P("Career"));
  expect(await side(page, P("Career"))).toBe("below");
  await expect(page.getByRole("rowgroup", { name: "Career contents" })).toHaveAttribute("tabindex", "-1");
  await expect(caret(page, P("Career"))).toHaveAttribute("aria-label", "Collapse Career");
  // Its children are entries of the pane, shown as mini tiles; the name is bold.
  await expect(mini(page, P("Career/Applications"))).toBeVisible();
  expect(await tile(page, P("Career")).locator(".entry-name").evaluate(el => getComputedStyle(el).fontWeight)).toBe("600");

  await toggle(page, P("Personal"));
  expect([await side(page, P("Career")), await side(page, P("Personal"))]).toEqual(["below", "below"]);
  // Inbox (column 4) cannot share the band with Career (2) and Personal (5).
  await toggle(page, P("Inbox"));
  expect(await side(page, P("Inbox"))).toBe("above");
  await toggle(page, P("AI Draft Archive"));
  expect(await side(page, P("AI Draft Archive"))).toBe("above");
  // Codex (3) fits neither band: a stacked panel under the below band.
  await toggle(page, P("Codex"));
  expect(await side(page, P("Codex"))).toBe("stacked");
  expect([await side(page, P("Career")), await side(page, P("Personal")), await side(page, P("Inbox")), await side(page, P("AI Draft Archive"))])
    .toEqual(["below", "below", "above", "above"]);
  const stacked = await rect(page, P("Codex"));
  for (const path of ["Career", "Personal"]) {
    const below = await rect(page, P(path));
    expect(stacked.y).toBeGreaterThan(below.y + below.height);
  }
  await expect(page.locator(`${shown} .tile-outline`)).toHaveCount(5);
});

test("a band splits its columns between members and re-splits when one closes", async ({ page }) => {
  await open(page);
  await toggle(page, P("Career"));
  const alone = await rect(page, P("Career"));
  await toggle(page, P("Personal"));
  const career = await rect(page, P("Career")), personal = await rect(page, P("Personal"));
  // One band: same top, no overlap, at least 24px apart.
  expect(Math.abs(career.y - personal.y)).toBeLessThan(1);
  expect(personal.x - (career.x + career.width)).toBeGreaterThanOrEqual(23.5);
  await toggle(page, P("Personal"));
  const again = await rect(page, P("Career"));
  expect([Math.round(again.x), Math.round(again.width)]).toEqual([Math.round(alone.x), Math.round(alone.width)]);
});

test("sizes the mini grid by its count and the height by the default preference", async ({ page }) => {
  await open(page);
  const rowsOf = async (path: string) => panel(page, path).locator(".tile-panel-row").evaluateAll(rows => rows.map(row => row.querySelectorAll(".entry-item").length));
  // 9 items: two rows, five columns; content shorter than the default, so content-sized.
  await toggle(page, P("Career"));
  expect(await rowsOf(P("Career"))).toEqual([5, 4]);
  const scroll = panel(page, P("Career")).locator(".tile-panel-scroll");
  expect(await scroll.evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await toggle(page, P("Career"));
  // 50 items: as wide as fits, 3.5 rows tall, with "+N more" and a bottom fade.
  await toggle(page, P("Archive"));
  const archive = panel(page, P("Archive"));
  const counts = await rowsOf(P("Archive"));
  expect(counts[0]).toBe(7);
  const metrics = await archive.evaluate(el => {
    const row = el.querySelector<HTMLElement>(".tile-panel-row")!;
    return { height: el.getBoundingClientRect().height, row: row.getBoundingClientRect().height };
  });
  expect(metrics.height).toBeCloseTo(3.5 * metrics.row + 20, 0);
  await expect(archive.locator(".tile-panel-more")).toHaveText(/^\+\d+ more$/);
});

test("the grip resizes the whole band, is remembered after reopening and is clamped", async ({ page }) => {
  await open(page);
  await toggle(page, P("Personal"));
  const grip = panel(page, P("Personal")).getByRole("separator", { name: "Resize Personal" });
  const height = async () => (await rect(page, P("Personal"))).height;
  const start = await height();
  const drag = async (dy: number) => {
    const box = (await grip.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy / 2, { steps: 3 });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 3 });
    await page.mouse.up();
    await settled(page);
  };
  await drag(-40);
  // Preferred heights are whole pixels.
  expect(Math.abs(await height() - (start - 40))).toBeLessThanOrEqual(0.5);
  await expect(grip).toHaveAttribute("aria-valuenow", String(Math.round(start - 40)));
  // Remembered across close and re-open.
  const resized = await height();
  await toggle(page, P("Personal"));
  await toggle(page, P("Personal"));
  expect(await height()).toBe(resized);
  // Clamped to one mini row (plus padding) and to the content.
  await drag(-2000);
  const row = await panel(page, P("Personal")).locator(".tile-panel-row").first().evaluate(el => el.getBoundingClientRect().height);
  expect(await height()).toBeCloseTo(row + 20, 0);
  await drag(4000);
  const content = await panel(page, P("Personal")).locator(".tile-panel-scroll").evaluate(el => el.scrollHeight);
  expect(await height()).toBeCloseTo(Math.min(content, 0.7 * await scroller(page).evaluate(el => el.clientHeight)), 0);
  // Keys: Home is the minimum.
  await panel(page, P("Personal")).getByRole("separator").focus();
  await page.keyboard.press("Home");
  await settled(page);
  expect(await height()).toBeCloseTo(row + 20, 0);

  // A band shares its height: Career's default raises it, and shrinking
  // Personal's grip shrinks Career too.
  await toggle(page, P("Career"));
  expect(Math.abs((await rect(page, P("Career"))).y - (await rect(page, P("Personal"))).y)).toBeLessThan(1);
  expect(await height()).toBeGreaterThan(row + 21);
  await drag(-2000);
  expect((await rect(page, P("Career"))).height).toBeCloseTo(row + 20, 0);
});

test("a stacked panel's label: × closes it and the label scrolls to the parent", async ({ page }) => {
  await open(page);
  for (const name of ["Career", "Personal", "Inbox", "AI Draft Archive", "Codex"]) await toggle(page, P(name));
  const codex = panel(page, P("Codex"));
  const label = codex.locator(".tile-panel-label");
  await expect(label).toContainText("Codex");
  await expect(label).toContainText("· 14 items");
  // A ribbon links the label to its parent; hovering it emphasizes Codex's outline.
  const outline = page.locator(`${shown} .tile-outline[data-panel-owner="${P("Codex")}"]`);
  const ribbon = outline.locator(".outline-ribbon-hit");
  await expect(ribbon).toHaveCount(1);
  const middle = await ribbon.evaluate(path => {
    const line = path as SVGPathElement;
    const origin = line.ownerSVGElement!.getBoundingClientRect();
    const point = line.getPointAtLength(line.getTotalLength() / 2);
    return { x: origin.x + point.x, y: origin.y + point.y };
  });
  await page.mouse.move(middle.x, middle.y);
  await expect(outline).toHaveCSS("opacity", "1");
  await page.mouse.move(5, 790);
  await expect(outline).toHaveCSS("opacity", "0.78");
  // Scroll the label to the top, leaving its parent row above the scrollport.
  await label.evaluate(el => el.scrollIntoView({ block: "start" }));
  await expect.poll(async () => {
    const [box, port] = await Promise.all([tile(page, P("Codex")).boundingBox(), scroller(page).boundingBox()]);
    return !box || box.y + box.height < port!.y;
  }).toBe(true);
  await label.locator("b").click();
  await expect.poll(async () => {
    const [box, port] = await Promise.all([tile(page, P("Codex")).boundingBox(), scroller(page).boundingBox()]);
    return !!box && box.y >= port!.y - 1 && box.y + box.height <= port!.y + port!.height + 1;
  }).toBe(true);
  await settled(page);
  await codex.getByRole("button", { name: "Close Codex" }).click();
  await expect(panel(page, P("Codex"))).toHaveCount(0);
  await expect(caret(page, P("Codex"))).toHaveAttribute("aria-expanded", "false");
  await settled(page);
});

test("an above band keeps the clicked row fixed on screen", async ({ page }) => {
  const base = "/folder-peek-tiles-rows";
  expect(await open(page, base)).toBe(7);
  // Row 3 holds Folder 22..24: open 24 below, then 23 (its neighbour) goes above.
  await toggle(page, P("Folder 24", base));
  const before = (await tile(page, P("Folder 23", base)).boundingBox())!.y;
  // Sample the row during the motion as well as after it.
  const during = await page.evaluate(async ([selector, path]) => {
    const pane = document.querySelector(selector)!;
    const cell = () => pane.querySelector<HTMLElement>(`.tile-row .entry-item[data-path="${path}"]`)!;
    cell().querySelector<HTMLElement>(".peek-caret")!.click();
    const ys: number[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      ys.push(cell().getBoundingClientRect().y);
    }
    return ys;
  }, [shown, P("Folder 23", base)] as const);
  await settled(page);
  expect(await side(page, P("Folder 23", base))).toBe("above");
  // Mid-motion frames allow 2px: WebKit keeps the outer scroll offset in whole
  // pixels while the mixed geometry is fractional (an unanchored row jumps ~200px).
  for (const y of during) expect(Math.abs(y - before)).toBeLessThan(2);
  expect(Math.abs((await tile(page, P("Folder 23", base)).boundingBox())!.y - before)).toBeLessThan(1.5);
  // The opened panel is fully on screen, above its parent.
  const [box, port] = await Promise.all([rect(page, P("Folder 23", base)), scroller(page).boundingBox()]);
  expect(box.y).toBeGreaterThanOrEqual(port!.y - 1);
});

test("an above band at the top of the list moves its row down by the shortfall, within the motion", async ({ page }) => {
  const base = "/folder-peek-tiles-rows";
  expect(await open(page, base)).toBe(7);
  // Row 0 holds Folder 01..07: open 07 below, then 06 goes above. With the list
  // at its top, keeping row 0 fixed would put the new panel above the viewport.
  await toggle(page, P("Folder 07", base));
  const before = (await tile(page, P("Folder 06", base)).boundingBox())!.y;
  // Each frame records the row and the opening panel's height. Times count from
  // the row's first movement: the motion starts when the folder's listing
  // arrives, which a loaded host can delay after the click.
  const samples = await page.evaluate(async ([selector, path]) => {
    const pane = document.querySelector(selector)!;
    const cell = () => pane.querySelector<HTMLElement>(`.tile-row .entry-item[data-path="${path}"]`)!;
    const y0 = cell().getBoundingClientRect().y;
    cell().querySelector<HTMLElement>(".peek-caret")!.click();
    const clicked = performance.now();
    let moved: number | null = null;
    const out: { t: number; y: number; height: number }[] = [];
    while (performance.now() - (moved ?? clicked) < (moved === null ? 5000 : 600)) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const y = cell().getBoundingClientRect().y;
      if (moved === null && Math.abs(y - y0) > 0.5) moved = performance.now();
      const box = pane.querySelector<HTMLElement>(`.tile-panel[data-path="${path}"]`)?.getBoundingClientRect();
      out.push({ t: moved === null ? -1 : performance.now() - moved, y, height: box?.height ?? 0 });
    }
    return out;
  }, [shown, P("Folder 06", base)] as const);
  expect(samples.some(s => s.t >= 0), "the row moved").toBe(true);
  await settled(page);
  expect(await side(page, P("Folder 06", base))).toBe("above");
  const [box, port, row] = await Promise.all([rect(page, P("Folder 06", base)), scroller(page).boundingBox(), tile(page, P("Folder 06", base)).boundingBox()]);
  // The panel's top is at the viewport's top: fully shown, not pushed above it.
  expect(box.y).toBeGreaterThanOrEqual(port!.y - 1);
  expect(box.y - port!.y).toBeLessThan(16);
  // The row moved down by only that shortfall: it sits right below its panel.
  expect(row!.y).toBeGreaterThan(before + box.height - 1);
  expect(row!.y - (box.y + box.height)).toBeLessThan(24);
  // All of it happens in the open motion. By the frame the panel has grown to
  // its full height, the row is already in place (no separate reveal scroll
  // after the motion); from 250ms after the row starts to move, nothing moves;
  // and the row never moves up.
  const grown = samples.filter(s => s.height >= box.height - 1);
  expect(grown.length).toBeGreaterThan(0);
  for (const s of grown) expect(Math.abs(s.y - row!.y), `row once the panel is full, at ${Math.round(s.t)}ms`).toBeLessThan(1.5);
  for (const s of samples.filter(s => s.t >= 250)) expect(Math.abs(s.y - row!.y), `row at ${Math.round(s.t)}ms`).toBeLessThan(1.5);
  for (let i = 1; i < samples.length; i++) expect(samples[i].y).toBeGreaterThanOrEqual(samples[i - 1].y - 1);
});

test("a column-count change keeps each panel on its side while feasible", async ({ page }) => {
  expect(await open(page, root, { width: 730, height: 800 })).toBe(5);
  await toggle(page, P("Career"));
  // At 5 columns Career (2) and Inbox (4) cannot share a band.
  await toggle(page, P("Inbox"));
  expect(await side(page, P("Inbox"))).toBe("above");
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(() => columns(page)).toBe(7);
  await settled(page);
  expect([await side(page, P("Career")), await side(page, P("Inbox"))]).toEqual(["below", "above"]);
  // Only memory keeps it there: re-opened now, Inbox fits below.
  await toggle(page, P("Inbox"));
  await toggle(page, P("Inbox"));
  expect(await side(page, P("Inbox"))).toBe("below");
});

test("a kept side survives navigating away and back, and a view-mode round trip", async ({ page }) => {
  expect(await open(page, root, { width: 730, height: 800 })).toBe(5);
  await toggle(page, P("Career"));
  await toggle(page, P("Inbox"));
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(() => columns(page)).toBe(7);
  await settled(page);
  expect(await side(page, P("Inbox"))).toBe("above");
  // Into Codex and back: Inbox is still expanded and keeps its side, although
  // Codex's layout never placed it.
  await explorerCall(page, "return explorer.navigateTo(value)", P("Codex"));
  await expect(tile(page, P("Codex/notes.md"))).toBeVisible();
  await explorerCall(page, "return explorer.goBack()");
  await expect(panel(page, P("Inbox"))).toHaveCount(1);
  await settled(page);
  expect(await side(page, P("Inbox"))).toBe("above");
  // Details unmounts the panels view; Tiles mounts a new one.
  await explorerCall(page, "explorer.setViewMode('details')");
  await expect(page.locator(`${shown} .tile-row`)).toHaveCount(0);
  await explorerCall(page, "explorer.setViewMode('tiles')");
  await expect(panel(page, P("Inbox"))).toHaveCount(1);
  await settled(page);
  expect(await side(page, P("Inbox"))).toBe("above");
  // Closing forgets the side: re-opened, Inbox fits below.
  await toggle(page, P("Inbox"));
  await toggle(page, P("Inbox"));
  expect(await side(page, P("Inbox"))).toBe("below");
});

test("arrow keys enter a panel, walk its grid and leave it again", async ({ page }) => {
  await open(page);
  await toggle(page, P("Career"));
  await tile(page, P("Career")).click();
  const focused = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.path ?? null);
  await expect.poll(focused).toBe(P("Career"));
  await page.keyboard.press("ArrowDown");
  // The mini tile under the parent's centre.
  await expect.poll(focused).toBe(P("Career/Portfolio"));
  await page.keyboard.press("ArrowRight");
  await expect.poll(focused).toBe(P("Career/headshot.jpg"));
  await page.keyboard.press("ArrowLeft");
  await expect.poll(focused).toBe(P("Career/Portfolio"));
  // Two rows of five: Portfolio (offset 2) sits above Resume-2026.pdf (offset 7).
  await page.keyboard.press("ArrowDown");
  await expect.poll(focused).toBe(P("Career/Resume-2026.pdf"));
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect.poll(focused).toBe(P("Career"));
  // Leaving the panel's last row reaches the next grid row.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(focused).not.toMatch(new RegExp(`^${P("Career")}`));
  const landed = (await focused())!;
  const [landedBox, careerBox] = await Promise.all([tile(page, landed).boundingBox(), tile(page, P("Career")).boundingBox()]);
  expect(landedBox!.y).toBeGreaterThan(careerBox!.y + careerBox!.height);
  // Shift extends across levels in visible-entries order.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+ArrowUp");
  expect((await explorerCall<string[]>(page, "return [...explorer.selectedPaths]")).length).toBeGreaterThan(1);
});

test("a drop onto a panel's surface moves the file into its folder", async ({ page }) => {
  await open(page);
  await toggle(page, P("Career"));
  const drag = (selector: string, types: string[]) => page.evaluate(async ([target, events, source]) => {
    const { createHtml5FileDrag } = await import("/src/lib/state/html5-file-drag.svelte.ts");
    const w = window as unknown as { __fptDrag?: DataTransfer };
    if (!w.__fptDrag) {
      w.__fptDrag = new DataTransfer();
      createHtml5FileDrag().start(new DragEvent("dragstart", { dataTransfer: w.__fptDrag }), { path: source, name: "bot_pat.txt", kind: "file" });
    }
    const element = document.querySelector(target)!;
    for (const type of events) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: w.__fptDrag }));
  }, [selector, types, P("bot_pat.txt")] as const);
  const surface = `${shown} .tile-panel[data-path="${P("Career")}"] .tile-panel-content`;
  await drag(surface, ["dragenter", "dragover"]);
  // The panel and its parent tile both show the folder as the target; the pane background does not.
  await expect(panel(page, P("Career"))).toHaveClass(targeted);
  await expect(tile(page, P("Career"))).toHaveClass(targeted);
  await expect(page.locator(`${shown} .content.drop-target`)).toHaveCount(0);
  // Over a mini tile the panel's feedback retires (the tile is its own target).
  await drag(`${shown} .tile-panel .entry-item[data-path="${P("Career/headshot.jpg")}"]`, ["dragenter", "dragover"]);
  await expect(panel(page, P("Career"))).not.toHaveClass(targeted);
  await expect(tile(page, P("Career"))).not.toHaveClass(targeted);
  await drag(surface, ["dragover", "drop"]);
  await expect(page.locator(".toast").filter({ hasText: /Moved/ })).toHaveCount(1);
  expect(await page.evaluate(async () => (await import("/src/lib/api/mock-fixtures.ts")).mockFiles["/folder-peek-tiles/Career"].map(entry => entry.name))).toContain("bot_pat.txt");
});

test("double-clicking a panel's subfolder navigates into it", async ({ page }) => {
  await open(page);
  await toggle(page, P("Career"));
  // Subfolders in a panel have no caret: Tiles peeks top-level folders only.
  await expect(mini(page, P("Career/Applications")).locator(".peek-caret")).toHaveCount(0);
  await mini(page, P("Career/Applications")).dblclick();
  await expect.poll(() => explorerCall<string>(page, "return explorer.currentPath")).toBe(P("Career/Applications"));
});

test("Peek into Folder on a panel's subfolder acts on its panel and records no hidden expansion", async ({ page }) => {
  await open(page);
  await toggle(page, P("Career"));
  await mini(page, P("Career/Applications")).click();
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.locator(".search-input").fill("Peek into Folder");
  await palette.locator(".command-item", { hasText: "Peek into Folder" }).first().click();
  await expect(palette).toBeHidden();
  // Tiles peeks top-level folders only: the subfolder is a leaf, like a file,
  // so the command toggles the panel holding it.
  await expect(panel(page, P("Career"))).toHaveCount(0);
  await expect(caret(page, P("Career"))).toHaveAttribute("aria-expanded", "false");
  await settled(page);
  expect(await explorerCall<string[]>(page, "return [...explorer.expandedPaths]")).toEqual([]);
});

interface Region { x: number; y: number; width: number; height: number }
/** Pixels the outline layer paints in each region (viewport px): a screenshot
 * with the layer shown against one with it hidden, so the count is what the
 * outlines put on screen, whatever the theme. */
async function outlinePaint(page: Page, regions: Record<string, Region>, threshold: number): Promise<Record<string, number>> {
  const viewportWidth = page.viewportSize()!.width;
  const painted = decodePng(await page.screenshot());
  await page.evaluate(selector => document.querySelectorAll<SVGElement>(`${selector} .tile-outlines`).forEach(svg => { svg.style.visibility = "hidden"; }), shown);
  const bare = decodePng(await page.screenshot());
  await page.evaluate(selector => document.querySelectorAll<SVGElement>(`${selector} .tile-outlines`).forEach(svg => { svg.style.visibility = ""; }), shown);
  const scale = painted.width / viewportWidth;
  return Object.fromEntries(Object.entries(regions).map(([name, r]) => {
    let changed = 0;
    for (let y = Math.max(0, Math.floor(r.y * scale)); y < Math.min(painted.height, Math.ceil((r.y + r.height) * scale)); y++) {
      for (let x = Math.max(0, Math.floor(r.x * scale)); x < Math.min(painted.width, Math.ceil((r.x + r.width) * scale)); x++) {
        if (colorDistance(painted.pixel(x, y), bare.pixel(x, y)) > threshold) changed++;
      }
    }
    return [name, changed / (scale * scale)];
  }));
}

test("outlines paint the contour, accent, fill, ribbon and parent highlight", async ({ page }) => {
  await open(page);
  for (const name of ["Career", "Personal", "Inbox", "AI Draft Archive", "Codex"]) await toggle(page, P(name));
  await scroller(page).evaluate(el => { el.scrollTop = 0; });
  await page.mouse.move(5, 5);
  await settled(page);
  const career = await rect(page, P("Career"));
  const parent = (await tile(page, P("Codex")).boundingBox())!;
  const ribbon = await page.locator(`${shown} .outline-ribbon-hit`).first().evaluate(el => {
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  });
  const port = (await scroller(page).boundingBox())!;
  const strokes = await outlinePaint(page, {
    // The hairline down a below panel's side, the accent along its parent-facing
    // top edge (clear of the tab), a stacked panel's ribbon and its parent's highlight.
    side: { x: career.x - 3, y: career.y + career.height * 0.4, width: 6, height: career.height * 0.3 },
    top: { x: career.x + career.width - 40, y: career.y - 3, width: 24, height: 6 },
    ribbon: { ...ribbon, height: Math.min(ribbon.height, port.y + port.height - ribbon.y) },
    highlight: { x: parent.x - 3, y: parent.y + 10, width: 6, height: parent.height - 20 },
  }, 4);
  expect(strokes.side).toBeGreaterThan(20);
  expect(strokes.top).toBeGreaterThan(20);
  expect(strokes.ribbon).toBeGreaterThan(300);
  expect(strokes.highlight).toBeGreaterThan(50);
  // The fill is a faint tint: below the panel's last row, every pixel changes a little.
  const fill: Region = { x: career.x + career.width * 0.3, y: career.y + career.height - 7, width: career.width * 0.3, height: 4 };
  expect((await outlinePaint(page, { fill }, 1)).fill).toBeGreaterThan(fill.width * fill.height * 0.8);
});

test("hover emphasis is immediate, with no transition", async ({ page }) => {
  await open(page);
  await toggle(page, P("Career"));
  const outline = page.locator(`${shown} .tile-outline[data-panel-owner="${P("Career")}"]`);
  await page.mouse.move(5, 790);
  await expect(outline).toHaveCSS("opacity", "0.78");
  const style = await outline.evaluate(el => ({ duration: getComputedStyle(el).transitionDuration }));
  expect(style.duration.split(",").every(value => parseFloat(value) === 0)).toBe(true);
  // The frame after the pointer reaches the panel already shows full opacity.
  const box = await rect(page, P("Career"));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(await outline.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
  await page.mouse.move(5, 790);
  expect(await outline.evaluate(el => getComputedStyle(el).opacity)).toBe("0.78");
  // Hovering the parent tile emphasizes its outline too.
  await tile(page, P("Career")).hover();
  expect(await outline.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
});

test("opening animates with inert ghosts and the reduced-motion path is instant", async ({ page }) => {
  await page.clock.install();
  await open(page);
  await toggle(page, P("Career"));
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const sample = async () => {
    const sampling = page.evaluate(async ([selector, path]) => {
      const pane = document.querySelector(selector)!;
      (pane.querySelector(`.tile-row .entry-item[data-path="${path}"] .peek-caret`) as HTMLElement).click();
      const frames: { ghosts: number; ghostIdentity: number; heights: string }[] = [];
      for (let i = 0; i < 6; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const ghosts = [...pane.querySelectorAll<HTMLElement>(".tile-panel-ghost")];
        frames.push({
          ghosts: ghosts.length,
          ghostIdentity: ghosts.filter(g => g.matches("[data-path], [role], [tabindex]") || g.querySelector(".entry-item, .tile-item, .peek-drop-target, .drop-target, [data-path], [data-index], [role]:not(svg [role]), [tabindex]") || !g.inert || g.getAttribute("aria-hidden") !== "true").length,
          heights: [...pane.querySelectorAll<HTMLElement>(".tiles-scroller .virtual-item")].slice(0, 2).map(el => el.style.height).join(),
        });
      }
      return frames;
    }, [shown, P("Career")] as const);
    // Deliberately stall longer than the 150ms motion. The controlled rAF and
    // performance clocks must still deliver six intermediate rendered frames.
    await page.waitForTimeout(200);
    await page.clock.runFor(100);
    return sampling;
  };
  // Closing: a ghost collapses while the group height shrinks frame by frame.
  const closing = await sample();
  expect(closing.some(frame => frame.ghosts === 1)).toBe(true);
  expect(closing.every(frame => frame.ghostIdentity === 0)).toBe(true);
  expect(closing).toHaveLength(6);
  expect(new Set(closing.map(frame => frame.heights)).size).toBeGreaterThan(2);
  await page.clock.runFor(200);
  await settled(page);
  // Reduced motion: no ghost or in-between frame. Opening may still change
  // once more when the listing arrives (data, not motion); closing is one step.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const opening = await sample();
  expect(opening.every(frame => frame.ghosts === 0)).toBe(true);
  expect(new Set(opening.map(frame => frame.heights)).size).toBeLessThanOrEqual(2);
  await expect(panel(page, P("Career"))).toHaveCount(1);
  await settled(page);
  const closingReduced = await sample();
  expect(closingReduced.every(frame => frame.ghosts === 0)).toBe(true);
  expect(new Set(closingReduced.map(frame => frame.heights)).size).toBe(1);
  await expect(panel(page, P("Career"))).toHaveCount(0);
});

test("interrupted toggles leave no ghost, faded panel or hidden tile", async ({ page }) => {
  await open(page);
  const folders = ["Career", "Archive", "Personal", "Inbox", "Codex", "AI Draft Archive"].map(name => P(name));
  let seed = 11;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 40; i++) {
    const path = folders[Math.floor(random() * folders.length)];
    await page.evaluate(([selector, target]) => (document.querySelector(`${selector} .tile-row .entry-item[data-path="${target}"] .peek-caret`) as HTMLElement).click(), [shown, path] as const);
    await page.waitForTimeout(Math.floor(random() * 120));
  }
  await settled(page);
  const report = await page.evaluate(selector => {
    const pane = document.querySelector(selector)!;
    const port = pane.querySelector<HTMLElement>(".tiles-scroller")!.getBoundingClientRect();
    const problems: string[] = [];
    if (pane.querySelector(".tile-panel-ghost")) problems.push("ghost");
    for (const el of pane.querySelectorAll<HTMLElement>(".tile-panel")) {
      if (el.style.opacity) problems.push(`faded ${el.dataset.path}`);
      const r = el.getBoundingClientRect();
      for (const row of pane.querySelectorAll<HTMLElement>(".tile-row")) {
        const t = row.getBoundingClientRect();
        if (r.top < t.bottom - 1 && r.bottom > t.top + 1) problems.push(`panel ${el.dataset.path} overlaps a row`);
      }
    }
    // Every grid tile on screen is what the pointer hits at its centre.
    for (const cell of pane.querySelectorAll<HTMLElement>(".tile-row .entry-item")) {
      const r = cell.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (y < port.top || y > port.bottom) continue;
      if (getComputedStyle(cell).visibility !== "visible") problems.push(`hidden ${cell.dataset.path}`);
      const hit = document.elementFromPoint(x, y);
      if (!cell.contains(hit)) problems.push(`occluded ${cell.dataset.path}`);
    }
    return problems;
  }, shown);
  expect(report).toEqual([]);
  // The open set and the drawn panels agree.
  const expanded = (await explorerCall<string[]>(page, "return [...explorer.expandedPaths]")).sort();
  const drawn = await page.locator(`${shown} .tile-panel`).evaluateAll(els => els.map(el => (el as HTMLElement).dataset.path!).sort());
  expect(drawn).toEqual(expanded);
});

/** Grid counts and indices that contradict each other: an aria-rowcount whose
 * rows are not all indexed, or an index beyond its count. */
const gridAriaProblems = (page: Page) => page.evaluate(selector => {
  const grid = document.querySelector(`${selector} .tiles-view [role="grid"]`)!;
  const rowCount = grid.getAttribute("aria-rowcount"), colCount = grid.getAttribute("aria-colcount");
  const problems: string[] = [];
  const rows = [...grid.querySelectorAll('[role="row"]')];
  if (rowCount !== null) {
    for (const row of rows) {
      const index = row.getAttribute("aria-rowindex");
      if (index === null) problems.push(`row without aria-rowindex: ${row.className}`);
      else if (Number(index) > Number(rowCount)) problems.push(`aria-rowindex ${index} > ${rowCount}`);
    }
  }
  for (const cell of grid.querySelectorAll('[role="gridcell"][aria-colindex]')) {
    const index = Number(cell.getAttribute("aria-colindex"));
    if (colCount !== null && index > Number(colCount)) problems.push(`aria-colindex ${index} > ${colCount}: ${cell.getAttribute("data-path")}`);
    if (cell.closest(".tile-panel")) problems.push(`mini tile with aria-colindex: ${cell.getAttribute("data-path")}`);
  }
  return { problems, rowCount, colCount, indexedRows: rows.filter(row => row.hasAttribute("aria-rowindex")).length };
}, shown);

test("grid counts and indices stay consistent with and without panels", async ({ page }) => {
  expect(await open(page)).toBe(7);
  // No panel: the same grid semantics as classic Tiles.
  const plain = await gridAriaProblems(page);
  expect(plain.problems).toEqual([]);
  expect(plain.colCount).toBe("7");
  expect(Number(plain.rowCount)).toBeGreaterThan(1);
  expect(plain.indexedRows).toBeGreaterThan(1);
  // Panels make the grid non-uniform (labels, mini rows, grips, side-by-side
  // panels): only consistent attributes remain.
  for (const name of ["Career", "Personal", "Inbox", "Codex"]) await toggle(page, P(name));
  const banded = await gridAriaProblems(page);
  expect(banded.problems).toEqual([]);
  expect([banded.rowCount, banded.colCount, banded.indexedRows]).toEqual([null, null, 0]);
  for (const name of ["Career", "Personal", "Inbox", "Codex"]) await toggle(page, P(name));
  expect(await gridAriaProblems(page)).toEqual(plain);
});

test("panels pass the structural accessibility rules", async ({ page }) => {
  await open(page);
  for (const name of ["Career", "Personal", "Inbox", "AI Draft Archive", "Codex"]) await toggle(page, P(name));
  await toggle(page, P("Career")); // reopen below a busy row: every kind of band at once
  await toggle(page, P("Career"));
  const results = await new AxeBuilder({ page }).include(`${shown} .tiles-view`)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(["color-contrast", "scrollable-region-focusable"]).analyze();
  expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(", ")}`)).toEqual([]);
  await expect(panel(page, P("Codex")).getByRole("separator")).toHaveAttribute("aria-orientation", "horizontal");
});

test("10,000 tiles with three open panels keep a bounded number of mounted entries", async ({ page }) => {
  const base = "/folder-peek-tiles-large";
  await open(page, base);
  for (const name of ["Alpha", "Beta", "Gamma"]) await toggle(page, P(name, base));
  const mounted = () => page.locator(`${shown} .entry-item`).count();
  const atTop = await mounted();
  expect(atTop).toBeLessThan(400);
  // Each 400-item panel mounts only its visible rows.
  for (const name of ["Alpha", "Beta", "Gamma"]) expect(await panel(page, P(name, base)).locator(".entry-item").count()).toBeLessThan(120);
  await scroller(page).evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  await expect.poll(async () => page.locator(`${shown} .tile-row .entry-item`).first().getAttribute("data-path")).not.toBe(P("Alpha", base));
  expect(await mounted()).toBeLessThan(400);
  await scroller(page).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(tile(page, P("item-09999.txt", base))).toBeVisible();
  expect(await mounted()).toBeLessThan(400);
});

test("Folder Peek off gives classic Tiles: no carets, panels or bands", async ({ page }) => {
  await open(page);
  await toggle(page, P("Career"));
  await setting(page, { folderPeek: false });
  await expect(page.locator(`${shown} .tile-panels-view`)).toHaveCount(0);
  await expect(page.locator(`${shown} .tiles-view .tile-row .entry-item`).first()).toBeVisible();
  await expect(page.locator(`${shown} .tiles-view .peek-caret`)).toHaveCount(0);
  await expect(page.locator(`${shown} .tile-panel, ${shown} .tile-outline`)).toHaveCount(0);
  // Every row is the classic fixed height and holds only top-level entries.
  const heights = await page.locator(`${shown} .tiles-scroller .virtual-item`).evaluateAll(els => [...new Set(els.map(el => (el as HTMLElement).style.height))]);
  expect(heights).toHaveLength(1);
  expect(await page.locator(`${shown} .entry-item[data-path^="${P("Career")}/"]`).count()).toBe(0);
  // A click on a folder selects it and never peeks.
  await tile(page, P("Career")).click();
  expect(await explorerCall<number>(page, "return explorer.displayEntries.length")).toBe(90);
  await setting(page, { folderPeek: true });
  await expect(panel(page, P("Career"))).toHaveCount(1);
});

test("a grip drag whose band scrolls away mid-drag still commits on release and leaves no preview", async ({ page }) => {
  const base = "/folder-peek-tiles-large";
  await open(page, base);
  await toggle(page, P("Alpha", base));
  const grip = panel(page, P("Alpha", base)).getByRole("separator", { name: "Resize Alpha" });
  const start = (await rect(page, P("Alpha", base))).height;
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 4 });
  await expect(grip).toHaveClass(/dragging/);
  // Scrolling the list unmounts the band, grip and all, while the button is held.
  await scroller(page).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(panel(page, P("Alpha", base))).toHaveCount(0);
  await page.mouse.up();
  await scroller(page).evaluate(el => { el.scrollTop = 0; });
  await expect(panel(page, P("Alpha", base))).toBeVisible();
  await settled(page);
  await expect(page.locator(`${shown} .tile-panel-grip.dragging`)).toHaveCount(0);
  expect(Math.abs(await explorerCall<number>(page, "return explorer.tilePanelHeight(value)", P("Alpha", base)) - (start + 40))).toBeLessThanOrEqual(0.5);
  expect(Math.abs((await rect(page, P("Alpha", base))).height - (start + 40))).toBeLessThanOrEqual(0.5);
});

test("closing a panel keeps keyboard focus on its parent tile: caret and Escape", async ({ page }) => {
  await open(page);
  const active = () => page.evaluate(() => document.activeElement?.closest<HTMLElement>(".entry-item")?.dataset.path ?? document.activeElement?.tagName ?? null);
  await tile(page, P("Career")).click();
  await toggle(page, P("Career"));
  await expect.poll(active).toBe(P("Career"));
  // Every frame of the closing motion keeps focus on the parent (never BODY).
  const trail = await page.evaluate(async ([selector, path]) => {
    const pane = document.querySelector(selector)!;
    pane.querySelector<HTMLElement>(`.tile-row .entry-item[data-path="${path}"] .peek-caret`)!.click();
    const seen: (string | null)[] = [];
    for (let i = 0; i < 14; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      seen.push(document.activeElement?.closest<HTMLElement>(".entry-item")?.dataset.path ?? document.activeElement?.tagName ?? null);
    }
    return seen;
  }, [shown, P("Career")] as const);
  expect(new Set(trail)).toEqual(new Set([P("Career")]));
  await settled(page);
  expect(await active()).toBe(P("Career"));
  // Escape from a mini tile: the first clears the selection, the second
  // steps out, closing the panel with the cursor on its parent.
  await toggle(page, P("Career"));
  await mini(page, P("Portfolio", P("Career"))).click();
  await expect.poll(active).toBe(P("Portfolio", P("Career")));
  await page.keyboard.press("Escape");
  await expect(page.locator(`${shown} .entry-item.selected`)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(caret(page, P("Career"))).toHaveAttribute("aria-expanded", "false");
  await settled(page);
  expect(await active()).toBe(P("Career"));
});

test("a panel whose slow listing settles after the motion window is still revealed", async ({ page }) => {
  const base = "/folder-peek-tiles-rows";
  await open(page, base, { width: 900, height: 500 });
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    getMockControl().latency = { list_directory_fresh: 2500 };
  });
  const path = P("Folder 15", base); // the third row, the last one on screen
  await caret(page, path).click();
  // Past the motion window (1.5s) the panel still shows its Loading row.
  await page.waitForTimeout(1700);
  expect(await explorerCall<string>(page, "return explorer.peekStatus(value) ?? 'none'", path)).toBe("loading");
  await expect.poll(() => explorerCall<string>(page, "return explorer.peekStatus(value) ?? 'none'", path), { timeout: 8000 }).toBe("loaded");
  await expect(panel(page, path).locator(".entry-item")).toHaveCount(8);
  await settled(page);
  const [box, port] = await Promise.all([rect(page, path), scroller(page).boundingBox()]);
  expect(box.y).toBeGreaterThanOrEqual(port!.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(port!.y + port!.height + 1);
});

test("the grip is a movable separator: bounds are exposed, arrows resize by one row, Home/End set the extremes", async ({ page }) => {
  await open(page);
  await toggle(page, P("Personal"));
  const grip = panel(page, P("Personal")).getByRole("separator", { name: "Resize Personal" });
  const height = async () => (await rect(page, P("Personal"))).height;
  const value = async (name: string) => Number(await grip.getAttribute(name));
  const rows = panel(page, P("Personal")).locator(".tile-panel-row");
  const rowHeight = await Promise.all([rows.nth(0).boundingBox(), rows.nth(1).boundingBox()]).then(([a, b]) => b!.y - a!.y);
  // The edge moves away from the parent to grow.
  const [grow, shrink] = await side(page, P("Personal")) === "above" ? ["ArrowUp", "ArrowDown"] : ["ArrowDown", "ArrowUp"];
  await expect(grip).toHaveAttribute("aria-orientation", "horizontal");
  await grip.focus();
  await page.keyboard.press("Home");
  await settled(page);
  // Home: the height is the exposed minimum.
  const min = await value("aria-valuemin");
  expect(await value("aria-valuenow")).toBe(min);
  expect(await height()).toBeCloseTo(min, 0);
  // Shrinking at the minimum is a no-op.
  await page.keyboard.press(shrink);
  await settled(page);
  expect(await height()).toBeCloseTo(min, 0);
  // One arrow is one mini row.
  await page.keyboard.press(grow);
  await settled(page);
  expect(await height()).toBeCloseTo(min + rowHeight, 0);
  expect(await value("aria-valuenow")).toBe(Math.round(min + rowHeight));
  await page.keyboard.press(shrink);
  await settled(page);
  expect(await height()).toBeCloseTo(min, 0);
  // End: the exposed maximum, which no arrow exceeds.
  await page.keyboard.press("End");
  await settled(page);
  const max = await value("aria-valuemax");
  expect(max).toBeGreaterThan(min + rowHeight);
  expect(await value("aria-valuenow")).toBe(max);
  expect(await height()).toBeCloseTo(max, 0);
  await page.keyboard.press(grow);
  await settled(page);
  expect(await height()).toBeCloseTo(max, 0);
  await page.keyboard.press(shrink);
  await settled(page);
  expect(await height()).toBeCloseTo(max - rowHeight, 0);
  // The value text counts whole rows.
  await expect(grip).toHaveAttribute("aria-valuetext", /^\d+ rows$/);
});

test("with a panel open Ctrl+A selects only the folder's own tiles and typeahead never lands on a peeked child", async ({ page }) => {
  await open(page);
  await toggle(page, P("Career"));
  await tile(page, P("Inbox")).click();
  await page.keyboard.press("ControlOrMeta+A");
  const all = await explorerCall<string[]>(page, "return [...explorer.selectedPaths]");
  expect(all).toHaveLength(90);
  expect(all.filter(path => path.startsWith(`${P("Career")}/`))).toEqual([]);
  await tile(page, P("Inbox")).click();
  // "offer" matches only Career/offer-letter.pdf, a peeked child: nothing moves.
  await page.keyboard.type("offer");
  expect(await explorerCall<string[]>(page, "return [...explorer.selectedPaths]")).toEqual([P("Inbox")]);
  await expect(mini(page, P("Career/offer-letter.pdf"))).not.toHaveClass(/selected/);
  // A depth-0 name still matches once the type-ahead buffer (800ms) has cleared.
  await page.waitForTimeout(900);
  await page.keyboard.type("cod");
  await expect.poll(() => explorerCall<string[]>(page, "return [...explorer.selectedPaths]")).toEqual([P("Codex")]);
});
