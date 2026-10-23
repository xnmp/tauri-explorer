import { test as base } from "@playwright/test";
import { test, expect, type Page } from "./fixtures";

// Spring-loaded peeks (#1242, spec §5): holding a drag over a closed folder
// for 600ms opens a temporary peek (a Details subtree, a List card, a Tiles
// panel); a drop inside it targets that folder; it closes when the drag
// leaves the folder and its peek, or ends. Synthetic HTML5 drag events are
// dispatched at real hit-tested points (`document.elementFromPoint`), so the
// gap crossings exercise the same hit testing as a real drag.
const root = "/folder-peek-spring";
const shown = ".pane-tree:not(.retained)";
const P = (name: string) => `${root}/${name}`;
/** List slot height (LIST_SLOT_HEIGHT). */
const LIST_SLOT = 30;
type View = "details" | "list" | "tiles";

const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (/derived_inert|effect_update_depth|state_unsafe_mutation/.test(message.text())) errors.push(message.text()); });
});
test.afterEach(async ({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });

async function open(page: Page, view: View) {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(`/?path=${root}&viewMode=${view}`);
  await expect(page.locator(`${shown} .entry-item[data-path="${P("Inbox")}"]`).first()).toBeVisible();
}
const explorer = <T>(page: Page, body: string, arg?: unknown) => page.evaluate(async ([source, value]) => {
  const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
  return new Function("explorer", "value", source)(windowTabsManager.getActiveExplorer()!, value);
}, [body, arg] as const) as Promise<T>;
const springPeeks = (page: Page) => explorer<string[]>(page, "return [...explorer.springPeeks]");
const listing = (page: Page, path: string) => page.evaluate(async dir =>
  (await import("/src/lib/api/mock-fixtures.ts")).mockFiles[dir]?.map(entry => entry.name) ?? null, path);

/** Starts an in-app HTML5 drag of `name` (a root file). */
const startDrag = (page: Page, name = "drag-me.txt") => page.evaluate(async ([path, label]) => {
  const { createHtml5FileDrag } = await import("/src/lib/state/html5-file-drag.svelte.ts");
  const w = window as unknown as { __spring?: { transfer: DataTransfer; last: Element | null } };
  w.__spring = { transfer: new DataTransfer(), last: null };
  createHtml5FileDrag().start(new DragEvent("dragstart", { dataTransfer: w.__spring.transfer }), { path, name: label, kind: "file" });
}, [P(name), name] as const);

/** Moves the drag to the element at a point of `selector`'s box (fractions of
 * its width/height, an offset in px below its bottom edge, or an offset in px
 * from its centre), dispatching dragenter/dragleave on a change of element and
 * a dragover, as an engine does. `related: false` leaves the dragleave's
 * relatedTarget null, as WebKit does. Returns the hit element's identifying
 * attributes (`row:` a Details row wrapper, `bridge:` a spring bridge). */
type At = { fx?: number; fy?: number; below?: number; dx?: number; dy?: number; related?: boolean };
type Point = { x: number; y: number };
/** `selector` may instead be a viewport point (CSS px), for a slot an element left. */
async function dragTo(page: Page, selector: string | Point, at: At = {}, types: string[] = ["dragover"]) {
  return page.evaluate(([target, point, events]) => {
    const w = window as unknown as { __spring: { transfer: DataTransfer; last: Element | null } };
    const box = typeof target === "string" ? document.querySelector(target)!.getBoundingClientRect() : new DOMRect(target.x, target.y, 0, 0);
    const x = box.left + box.width * (point.fx ?? 0.5) + (point.dx ?? 0);
    const y = (point.below !== undefined ? box.bottom + point.below : box.top + box.height * (point.fy ?? 0.5)) + (point.dy ?? 0);
    const hit = document.elementFromPoint(x, y)!;
    const init = { bubbles: true, cancelable: true, dataTransfer: w.__spring.transfer, clientX: x, clientY: y };
    if (hit !== w.__spring.last) {
      hit.dispatchEvent(new DragEvent("dragenter", init));
      w.__spring.last?.dispatchEvent(new DragEvent("dragleave", { ...init, relatedTarget: point.related === false ? null : hit }));
      w.__spring.last = hit;
    }
    for (const type of events) hit.dispatchEvent(new DragEvent(type, init));
    const owner = hit.closest("[data-spring-bridge], [data-peek-state], [data-path], [data-row-path]");
    if (!owner) return hit.tagName;
    if (owner.hasAttribute("data-spring-bridge")) return `bridge:${owner.getAttribute("data-spring-bridge")}`;
    if (owner.hasAttribute("data-row-path") && !owner.hasAttribute("data-path")) return `row:${owner.getAttribute("data-row-path")}`;
    return owner.getAttribute("data-peek-state") ?? owner.getAttribute("data-path")!;
  }, [selector, at, types] as const);
}
/** The drag leaves the window: a dragleave with no relatedTarget and no dragenter. */
const leaveWindow = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __spring: { transfer: DataTransfer; last: Element | null } };
  w.__spring.last?.dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, dataTransfer: w.__spring.transfer, relatedTarget: null }));
  w.__spring.last = null;
});
const dropOn = (page: Page, selector: string | Point, at = {}) => dragTo(page, selector, at, ["dragover", "drop"]);
const centerOf = async (page: Page, selector: string): Promise<Point> => {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
/** The spring stays exactly `paths` while the drag keeps hovering `point`
 * (a re-layout that moved the hovered row away would close and re-spring it). */
async function holdsOpen(page: Page, point: Point | string, paths: string[], samples = 6) {
  for (let i = 0; i < samples; i++) {
    await dragTo(page, point);
    expect(await springPeeks(page)).toEqual(paths);
    await page.waitForTimeout(150);
  }
}
/** The source's dragend (a drop's, or Escape/cancel's: dropEffect none). */
const endDrag = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __spring: { transfer: DataTransfer } };
  w.__spring.transfer.dropEffect = "none";
  document.body.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: w.__spring.transfer }));
});
const opened = (page: Page, paths: string[]) => expect.poll(() => springPeeks(page), { timeout: 4000 }).toEqual(paths);

// Per-view selectors: the folder's own row, a child row inside its peek, the
// peek's surface, and a point in the gap between folder and peek.
const views: Record<View, {
  folder: (path: string) => string;
  child: (path: string) => string;
  surface: (path: string) => string;
}> = {
  details: {
    folder: path => `${shown} .entry-item[data-path="${path}"]`,
    child: path => `${shown} .entry-item[data-path="${path}"]`,
    surface: path => `${shown} [data-peek-state="${path}"]`,
  },
  list: {
    folder: path => `${shown} .list-slot .entry-item[data-path="${path}"]`,
    child: path => `${shown} [data-card-scroll] .entry-item[data-path="${path}"]`,
    surface: path => `${shown} [data-card-scroll][data-path="${path}"]`,
  },
  tiles: {
    folder: path => `${shown} .tile-row .entry-item[data-path="${path}"]`,
    child: path => `${shown} .tile-panel .entry-item[data-path="${path}"]`,
    surface: path => `${shown} .tile-panel[data-path="${path}"]`,
  },
};

for (const view of ["details", "list", "tiles"] as const) {
  const v = views[view];
  test.describe(`${view}`, () => {
    test.beforeEach(async ({ page }) => open(page, view));

    for (const target of ["file", "empty"] as const) {
      test(`permanent peek ${target}: drops move into the open folder and retain its peek (#1323)`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const folder = P(target === "file" ? "Inbox" : "Empty");
        await explorer(page, "return explorer.togglePeek(value)", folder);
        const hit = target === "file" ? v.child(P("Inbox/alpha.txt")) : v.surface(folder);
        await expect(page.locator(hit)).toBeVisible();
        // Wait for structural motion before using elementFromPoint.
        await expect(page.locator(`${shown} [data-motion-key][style*="transform"], ${shown} [data-motion-key][style*="clip-path"], ${shown} .list-motion-layer > *`)).toHaveCount(0);
        await startDrag(page);
        await dragTo(page, hit);
        const targets = page.locator(`${shown} .drop-target[data-path="${folder}"]`);
        if (target === "file") await expect(targets).toHaveCount(1);
        else await expect.poll(() => targets.count()).toBeGreaterThan(0);
        await dropOn(page, hit);
        await expect.poll(() => listing(page, folder)).toContain("drag-me.txt");
        expect(await listing(page, root)).not.toContain("drag-me.txt");
        // Native sessions publish this mutation notification; the browser
        // mock does not run the native watcher (same seam as interactions).
        await explorer(page, "explorer.directoryChanged({path:value,origin:'mutation'})", folder);
        await endDrag(page);
        expect(await explorer(page, "return explorer.isPeekExpanded(value)", folder)).toBe(true);
        await expect(page.locator(v.child(`${folder}/drag-me.txt`))).toBeVisible();
        await expect(page.locator(`${shown} .drop-target`)).toHaveCount(0);
        if (target === "file") await page.screenshot({ path: `screenshots/fix/peek/permanent-peek-drop-${view}.png` });
      });
    }

    test("opens after 600ms and not before, without touching the expanded set or stored heights", async ({ page }) => {
      // A first spring loads the lazy driver and peek session in real time.
      await startDrag(page);
      await dragTo(page, v.folder(P("Inbox")));
      await opened(page, [P("Inbox")]);
      await expect(page.locator(v.child(P("Inbox/alpha.txt")))).toBeVisible();
      await endDrag(page);
      await opened(page, []);
      await expect(page.locator(v.child(P("Inbox/alpha.txt")))).toHaveCount(0);

      // The boundary, on a paused clock: closed at 599ms, open by 601ms.
      await page.clock.install();
      await page.clock.pauseAt(Date.now() + 60_000);
      await startDrag(page);
      await dragTo(page, v.folder(P("Archive")));
      await page.clock.runFor(599);
      expect(await springPeeks(page)).toEqual([]);
      await page.clock.runFor(2);
      await opened(page, [P("Archive")]);
      await page.clock.resume();
      await expect(page.locator(v.child(P("Archive/old.txt")))).toBeVisible();
      // Temporary: never in the expanded set, no card or panel height stored.
      expect(await explorer(page, "return [...explorer.expandedPaths]")).toEqual([]);
      expect(await explorer(page, "return [explorer.listCardRows(value) ?? null, explorer.tilePanelHeight(value) ?? null]", P("Archive"))).toEqual([null, null]);
      await endDrag(page);
      await opened(page, []);
      expect(await explorer(page, "return [...explorer.expandedPaths]")).toEqual([]);
    });

    test("a drop on a file row inside the peek moves the file into the folder, and no folder keeps drop feedback", async ({ page }) => {
      await startDrag(page);
      await dragTo(page, v.folder(P("Inbox")));
      await opened(page, [P("Inbox")]);
      // Cross the peek's own surface first (List: the gap between card rows;
      // Tiles: the panel's padding), which shows the folder's own feedback,
      // then a row's edge.
      if (view === "list") expect(await dragTo(page, v.child(P("Inbox/Nested")), { below: 1 })).toBe(P("Inbox"));
      if (view === "tiles") expect(await dragTo(page, v.surface(P("Inbox")), { fy: 0.97 })).toBe(P("Inbox"));
      await dragTo(page, v.child(P("Inbox/alpha.txt")), { fy: 0.02 });
      expect(await dragTo(page, v.child(P("Inbox/alpha.txt")))).toBe(P("Inbox/alpha.txt"));
      await page.waitForTimeout(60); // dragover repeats while a drag rests
      await dragTo(page, v.child(P("Inbox/alpha.txt")));
      // Feedback is on the folder once (its row, card or panel), not the file row.
      await expect(page.locator(`${v.child(P("Inbox/alpha.txt"))}.drop-target`)).toHaveCount(0);
      await expect(page.locator(`${shown} .drop-target[data-path="${P("Inbox")}"]`)).toHaveCount(1);
      // The drop lands on the row's top edge (Details: its wrapper's snapped band).
      await dropOn(page, v.child(P("Inbox/alpha.txt")), { fy: 0.02 });
      await expect.poll(() => listing(page, P("Inbox"))).toContain("drag-me.txt");
      expect(await listing(page, root)).not.toContain("drag-me.txt");
      await endDrag(page);
      await opened(page, []);
      await expect(page.locator(`${shown} .drop-target`)).toHaveCount(0);
      // The next drag over other items shows no stale feedback either.
      await startDrag(page, "other.txt");
      await dragTo(page, v.folder(P("zeta.txt")));
      await page.waitForTimeout(100);
      await dragTo(page, v.folder(P("zeta.txt")));
      await expect(page.locator(`${shown} .drop-target`)).toHaveCount(0);
      await endDrag(page);
    });

    test("a folder drop after crossing the listing background leaves no background highlight and no peek (#1269)", async ({ page }) => {
      // A source from another folder, so the pane background accepts it.
      await startDrag(page, "Inbox/alpha.txt");
      await dragTo(page, v.folder(P("zeta.txt")), { below: 60 });
      await expect(page.locator(`${shown} .content.drop-target`)).toHaveCount(1);
      await dragTo(page, v.folder(P("Archive")));
      await opened(page, [P("Archive")]);
      await dropOn(page, v.folder(P("Archive")));
      await expect.poll(() => listing(page, P("Archive"))).toContain("alpha.txt");
      await endDrag(page);
      await opened(page, []);
      await expect(page.locator(`${shown} .drop-target`)).toHaveCount(0);
      await expect(page.locator(`${shown} .content.drop-target`)).toHaveCount(0);
    });

    test("WebKit-style leaves (no relatedTarget) inside the window keep the peek; leaving the window closes it", async ({ page }) => {
      await startDrag(page);
      await dragTo(page, v.folder(P("Inbox")));
      await opened(page, [P("Inbox")]);
      // Spring state precedes the List card's rows and opening motion (#1292).
      for (const child of ["Inbox/alpha.txt", "Inbox/beta.txt"]) await expect(page.locator(v.child(P(child)))).toBeVisible();
      await expect(page.locator(`${shown} [data-motion-key][style*="transform"], ${shown} [data-motion-key][style*="clip-path"], ${shown} .list-motion-layer > *`)).toHaveCount(0);
      for (const child of ["Inbox/alpha.txt", "Inbox/beta.txt"]) await dragTo(page, v.child(P(child)), { related: false });
      await dragTo(page, v.folder(P("Inbox")), { related: false });
      await page.waitForTimeout(100);
      expect(await springPeeks(page)).toEqual([P("Inbox")]);
      await leaveWindow(page);
      await opened(page, []);
      await expect(page.locator(`${shown} .drop-target`)).toHaveCount(0);
      await endDrag(page);
    });

    test("a drop on the peek's own surface moves the file into the folder", async ({ page }) => {
      await startDrag(page);
      await dragTo(page, v.folder(P("Empty")));
      await opened(page, [P("Empty")]);
      await expect(page.locator(v.surface(P("Empty")))).toBeVisible();
      await dropOn(page, v.surface(P("Empty")));
      await expect.poll(() => listing(page, P("Empty"))).toEqual(["drag-me.txt"]);
      await endDrag(page);
      await opened(page, []);
    });

    test("crossing from the folder into its peek keeps it open; leaving both closes it", async ({ page }) => {
      await startDrag(page);
      await dragTo(page, v.folder(P("Inbox")));
      await opened(page, [P("Inbox")]);
      const rows = ["Inbox/Nested", "Inbox/alpha.txt", "Inbox/beta.txt"].map(child => v.child(P(child)));
      for (const row of rows) await expect(page.locator(row)).toBeVisible();
      // Spring state precedes the rendered card's opening motion. Hit-test
      // settled rows: an edge in the final box can still be clipped mid-motion.
      await expect(page.locator(`${shown} [data-motion-key][style*="transform"], ${shown} [data-motion-key][style*="clip-path"], ${shown} .list-motion-layer > *`)).toHaveCount(0);
      if (view === "tiles") {
        // The band gap between the tile and its panel hit-tests as the panel's bridge.
        expect(await dragTo(page, v.folder(P("Inbox")), { below: 5 })).toBe(`bridge:${P("Inbox")}`);
        expect(await dragTo(page, v.surface(P("Inbox")), { fy: 0.97 })).toBe(P("Inbox"));
      }
      for (const row of rows) await dragTo(page, row);
      // The pixel-snapped edges between rows inside the peek, then (List) the
      // card's own bottom edge.
      for (const row of rows) await dragTo(page, row, { fy: 0.02 });
      if (view === "list") expect(await dragTo(page, v.surface(P("Inbox")), { below: -2 })).toBe(P("Inbox"));
      await dragTo(page, v.folder(P("Inbox")));
      await page.waitForTimeout(100);
      // Any step outside would have closed it (re-opening takes another 600ms).
      expect(await springPeeks(page)).toEqual([P("Inbox")]);
      await dragTo(page, v.folder(P("other.txt")));
      await opened(page, []);
      await expect(page.locator(v.child(P("Inbox/alpha.txt")))).toHaveCount(0);
      // Leaving before the delay never opens it.
      await dragTo(page, v.folder(P("Archive")));
      await page.waitForTimeout(300);
      await dragTo(page, v.folder(P("zeta.txt")));
      await page.waitForTimeout(700);
      expect(await springPeeks(page)).toEqual([]);
    });

    test("drag cancel and a drop elsewhere close every temporary peek", async ({ page }) => {
      await startDrag(page);
      await dragTo(page, v.folder(P("Inbox")));
      await opened(page, [P("Inbox")]);
      await endDrag(page);
      await opened(page, []);
      // A drop on another folder row lands there and closes the peek too.
      await startDrag(page);
      await dragTo(page, v.folder(P("Inbox")));
      await opened(page, [P("Inbox")]);
      await dragTo(page, v.folder(P("Archive")));
      await opened(page, []);
      await dragTo(page, v.folder(P("Inbox")));
      await opened(page, [P("Inbox")]);
      await dropOn(page, v.folder(P("Inbox")));
      await opened(page, []);
      await expect.poll(() => listing(page, P("Inbox"))).toContain("drag-me.txt");
    });

    if (view !== "tiles") {
      test("a folder inside a temporary peek springs open in turn; leaving it keeps the outer peek", async ({ page }) => {
        await startDrag(page);
        await dragTo(page, v.folder(P("Inbox")));
        await opened(page, [P("Inbox")]);
        await dragTo(page, v.child(P("Inbox/Nested")));
        await opened(page, [P("Inbox"), P("Inbox/Nested")]);
        await expect(page.locator(v.child(P("Inbox/Nested/deep.txt")))).toBeVisible();
        await dragTo(page, v.child(P("Inbox/alpha.txt")));
        await opened(page, [P("Inbox")]);
        await dragTo(page, v.child(P("Inbox/Nested")));
        await opened(page, [P("Inbox"), P("Inbox/Nested")]);
        // A drop on the nested peek's row lands in the nested folder.
        await dropOn(page, v.child(P("Inbox/Nested/deep.txt")));
        await expect.poll(() => listing(page, P("Inbox/Nested"))).toContain("drag-me.txt");
        await endDrag(page);
        await opened(page, []);
        expect(await explorer(page, "return [...explorer.expandedPaths]")).toEqual([]);
      });
    } else {
      test("a folder inside a panel does not spring (panels do not nest)", async ({ page }) => {
        await startDrag(page);
        await dragTo(page, v.folder(P("Inbox")));
        await opened(page, [P("Inbox")]);
        await dragTo(page, v.child(P("Inbox/Nested")));
        await page.waitForTimeout(1000);
        expect(await springPeeks(page)).toEqual([P("Inbox")]);
        await endDrag(page);
        await opened(page, []);
      });
    }

    test("with Folder Peek off nothing springs open", async ({ page }) => {
      await page.evaluate(async () => (await import("/src/lib/state/settings.svelte.ts")).settingsStore.update({ folderPeek: false }));
      await expect(page.locator(`${shown} .entry-item[data-path="${P("Inbox")}"]`)).toBeVisible();
      await startDrag(page);
      await dragTo(page, `${shown} .entry-item[data-path="${P("Inbox")}"]`);
      await page.waitForTimeout(1200);
      await dragTo(page, `${shown} .entry-item[data-path="${P("Inbox")}"]`);
      expect(await springPeeks(page)).toEqual([]);
      await expect(page.locator(`${shown} .entry-item[data-path="${P("Inbox/alpha.txt")}"]`)).toHaveCount(0);
      await expect(page.locator(`${shown} .tile-panel, ${shown} [data-card-scroll]`)).toHaveCount(0);
      // The folder row is still an ordinary drop target.
      await dropOn(page, `${shown} .entry-item[data-path="${P("Inbox")}"]`);
      await expect.poll(() => listing(page, P("Inbox"))).toContain("drag-me.txt");
      await endDrag(page);
    });
  });
}

test("carets off changes nothing, and the pane background still drops into the current folder", async ({ page }) => {
  await open(page, "details");
  await page.evaluate(async () => (await import("/src/lib/state/settings.svelte.ts")).settingsStore.update({ folderPeekCarets: false }));
  await expect(page.locator(`${shown} .peek-caret`)).toHaveCount(0);
  await startDrag(page);
  await dragTo(page, views.details.folder(P("Inbox")));
  await opened(page, [P("Inbox")]);
  await endDrag(page);
  await opened(page, []);
  // A file from inside Inbox, dropped below the last row, lands in the pane's folder.
  await page.evaluate(async path => {
    const { createHtml5FileDrag } = await import("/src/lib/state/html5-file-drag.svelte.ts");
    const w = window as unknown as { __spring?: { transfer: DataTransfer; last: Element | null } };
    w.__spring = { transfer: new DataTransfer(), last: null };
    createHtml5FileDrag().start(new DragEvent("dragstart", { dataTransfer: w.__spring.transfer }), { path, name: "alpha.txt", kind: "file" });
  }, P("Inbox/alpha.txt"));
  expect(await dropOn(page, views.details.folder(P("zeta.txt")), { below: 60 })).not.toContain(root);
  await expect.poll(() => listing(page, root)).toContain("alpha.txt");
  await endDrag(page);
});

test("details: a drop on a row's pixel-snapped edge (its row wrapper) inside the peek lands in the peeked folder", async ({ page }) => {
  await open(page, "details");
  await startDrag(page);
  await dragTo(page, views.details.folder(P("Inbox")));
  await opened(page, [P("Inbox")]);
  // Hit-test the wrapper's edge band where the engine exposes it; otherwise
  // dispatch on the wrapper, which is where such a hit lands (#1242 review).
  await page.evaluate(path => {
    const w = window as unknown as { __spring: { transfer: DataTransfer; last: Element | null } };
    const wrapper = document.querySelector(`.pane-tree:not(.retained) [data-row-path="${path}"]`)!;
    const box = wrapper.getBoundingClientRect();
    const x = box.left + 160;
    let y = box.top + box.height / 2, target: Element = wrapper;
    for (let dy = -1; dy <= 1; dy += 0.125) {
      if (document.elementFromPoint(x, box.top + dy) === wrapper) { y = box.top + dy; break; }
    }
    const init = { bubbles: true, cancelable: true, dataTransfer: w.__spring.transfer, clientX: x, clientY: y };
    target.dispatchEvent(new DragEvent("dragenter", init));
    w.__spring.last?.dispatchEvent(new DragEvent("dragleave", { ...init, relatedTarget: target }));
    w.__spring.last = target;
    for (const type of ["dragover", "drop"]) target.dispatchEvent(new DragEvent(type, init));
  }, P("Inbox/alpha.txt"));
  await expect.poll(() => listing(page, P("Inbox"))).toContain("drag-me.txt");
  expect(await listing(page, root)).not.toContain("drag-me.txt");
  await endDrag(page);
  await opened(page, []);
});

test("an HTML5 drag whose source row leaves the virtual window under a big spring peek still drops", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto(`/?path=${root}&viewMode=details`);
  await expect(page.locator(views.details.folder(P("drag-me.txt")))).toBeVisible();
  // The real row starts the drag (its own dragstart handler, as an engine would).
  await page.evaluate(selector => {
    const w = window as unknown as { __spring?: { transfer: DataTransfer; last: Element | null } };
    w.__spring = { transfer: new DataTransfer(), last: null };
    document.querySelector(selector)!.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: w.__spring.transfer }));
  }, views.details.folder(P("drag-me.txt")));
  await dragTo(page, views.details.folder(P("Bulk")));
  await opened(page, [P("Bulk")]);
  await expect(page.locator(views.details.folder(P("drag-me.txt")))).toHaveCount(0);
  await dragTo(page, views.details.child(P("Bulk/bulk-02.txt")));
  await dropOn(page, views.details.child(P("Bulk/bulk-02.txt")));
  await expect.poll(() => listing(page, P("Bulk"))).toContain("drag-me.txt");
  await endDrag(page);
  await opened(page, []);
});

// The macOS/Windows in-app backend is a pointer drag driven by real mouse
// input (navigator.platform "MacIntel" selects it); Escape cancels it.
async function macPage(browser: import("@playwright/test").Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript(() => Object.defineProperty(window.navigator, "platform", { get: () => "MacIntel" }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const center = async (selector: string) => {
    const box = (await page.locator(selector).boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  return { context, page, errors, center };
}

base("pointer drag (macOS): holding over a folder springs it open, Escape closes it, a release on a child row moves into it", async ({ browser }, info) => {
  const { context, page, errors, center } = await macPage(browser, info.project.use.baseURL);
  await open(page, "details");
  const source = await center(views.details.folder(P("drag-me.txt")));
  const inbox = await center(views.details.folder(P("Inbox")));
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x, source.y - 10, { steps: 2 });
  await page.mouse.move(inbox.x, inbox.y, { steps: 4 });
  await opened(page, [P("Inbox")]);
  await page.keyboard.press("Escape");
  await opened(page, []);
  await page.mouse.up();

  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x, source.y - 10, { steps: 2 });
  await page.mouse.move(inbox.x, inbox.y, { steps: 4 });
  await opened(page, [P("Inbox")]);
  const alpha = await center(views.details.child(P("Inbox/alpha.txt")));
  await page.mouse.move(alpha.x, alpha.y, { steps: 3 });
  await expect(page.locator(`${shown} .entry-item.drop-target[data-path="${P("Inbox")}"]`)).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => listing(page, P("Inbox"))).toContain("drag-me.txt");
  await opened(page, []);
  expect(errors).toEqual([]);
  await context.close();
});

base("pointer drag (macOS): the drag survives its source row leaving the virtual window when a big folder springs open above it", async ({ browser }, info) => {
  const { context, page, errors, center } = await macPage(browser, info.project.use.baseURL);
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto(`/?path=${root}&viewMode=details`);
  await expect(page.locator(views.details.folder(P("drag-me.txt")))).toBeVisible();
  const source = await center(views.details.folder(P("drag-me.txt")));
  const bulk = await center(views.details.folder(P("Bulk")));
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x, source.y - 10, { steps: 2 });
  await page.mouse.move(bulk.x, bulk.y, { steps: 4 });
  await opened(page, [P("Bulk")]);
  // Bulk's 40 rows pushed the source row out of the rendered window.
  await expect(page.locator(views.details.folder(P("drag-me.txt")))).toHaveCount(0);
  const child = await center(views.details.child(P("Bulk/bulk-02.txt")));
  await page.mouse.move(child.x, child.y, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => listing(page, P("Bulk"))).toContain("drag-me.txt");
  await opened(page, []);
  expect(errors).toEqual([]);
  await context.close();
});

// Coordinator decision (#1242 review): the survival above is a cross-cutting
// pointer-drag fix that holds with Folder Peek off as well (a scroll moves the
// source row out of the virtual window just as a spring peek does).
base("pointer drag (macOS), Folder Peek off: the drag survives its source row scrolling out of the virtual window", async ({ browser }, info) => {
  const { context, page, errors, center } = await macPage(browser, info.project.use.baseURL);
  await page.setViewportSize({ width: 900, height: 420 });
  await page.goto(`/?path=${P("Bulk")}&viewMode=details`);
  await page.evaluate(async () => (await import("/src/lib/state/settings.svelte.ts")).settingsStore.update({ folderPeek: false }));
  const first = views.details.folder(P("Bulk/bulk-01.txt"));
  await expect(page.locator(first)).toBeVisible();
  const source = await center(first);
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x, source.y + 12, { steps: 2 });
  await page.mouse.wheel(0, 2000);
  await expect(page.locator(first)).toHaveCount(0);
  const crumb = await center(`${shown} .crumb[data-path="${root}"]`);
  await page.mouse.move(crumb.x, crumb.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => listing(page, root)).toContain("bulk-01.txt");
  expect(await listing(page, P("Bulk"))).not.toContain("bulk-01.txt");
  expect(await springPeeks(page)).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
});

base("pointer drag (macOS): a source deleted elsewhere mid-drag cancels the drag instead of attempting a move", async ({ browser }, info) => {
  const { context, page, errors, center } = await macPage(browser, info.project.use.baseURL);
  await open(page, "details");
  const source = await center(views.details.folder(P("drag-me.txt")));
  const inbox = await center(views.details.folder(P("Inbox")));
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  await page.mouse.move(source.x, source.y - 10, { steps: 2 });
  await page.mouse.move(inbox.x, inbox.y, { steps: 4 });
  await opened(page, [P("Inbox")]);
  // Another program deletes the source; the pane's refresh drops its row.
  await page.evaluate(async ([dir, name]) => {
    const { mockFiles } = await import("/src/lib/api/mock-fixtures.ts");
    mockFiles[dir] = mockFiles[dir].filter(entry => entry.name !== name);
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    await windowTabsManager.getActiveExplorer()!.refresh({ silent: true });
  }, [root, "drag-me.txt"] as const);
  await expect(page.locator(views.details.folder(P("drag-me.txt")))).toHaveCount(0);
  // The drag ended there: no ghost, no spring, no highlight, and the release moves nothing.
  await opened(page, []);
  await expect(page.locator(".pointer-drag-ghost")).toHaveCount(0);
  await expect(page.locator(`${shown} .drop-target`)).toHaveCount(0);
  await page.mouse.move(inbox.x, inbox.y + 4, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await listing(page, P("Inbox"))).toEqual(["Nested", "alpha.txt", "beta.txt"]);
  await expect(page.locator(".toast.error")).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

// A spring open must never move the hovered row out from under the pointer.
test.describe("list: spring cards keep the hovered row in place", () => {
  /** Opens List with exactly `rows` slots per column (engines differ in chrome height). */
  async function listAtRows(page: Page, width: number, rows: number) {
    await page.setViewportSize({ width, height: 400 });
    await page.goto(`/?path=${root}&viewMode=list`);
    await expect(page.locator(views.list.folder(P("Inbox")))).toBeVisible();
    const client = await page.locator(`${shown} .list-scroller`).evaluate(element => element.clientHeight);
    await page.setViewportSize({ width, height: 400 + rows * LIST_SLOT + 27 - client });
    await expect(page.locator(`${shown} .list-view`)).toHaveAttribute("data-rows", String(rows));
  }

  /** Card motion has settled (it clips and moves the live slots). */
  const settled = (page: Page) => expect(page.locator(`${shown} .list-motion-layer > *, ${shown} [data-motion-key][style*="transform"], ${shown} [data-motion-key][style*="clip-path"]`)).toHaveCount(0);

  // R=7: Archive, Bulk, Empty, then Inbox in rows 3..6; with Archive open too,
  // Inbox no longer fits below Empty and starts column 1.
  for (const [label, user] of [["in its column", ["Inbox"]], ["after it started the next column", ["Archive", "Inbox"]]] as const) {
    test(`a folder springing open inside a user card keeps the card where it was (R=7, ${label})`, async ({ page }) => {
      await listAtRows(page, 900, 7);
      for (const folder of user) await explorer(page, "return explorer.togglePeek(value)", P(folder));
      await expect(page.locator(views.list.child(P("Inbox/Nested")))).toBeVisible();
      await settled(page);
      const header = await centerOf(page, views.list.folder(P("Inbox")));
      const nested = await centerOf(page, views.list.child(P("Inbox/Nested")));
      await startDrag(page);
      expect(await dragTo(page, nested)).toBe(P("Inbox/Nested"));
      await opened(page, [P("Inbox/Nested")]);
      // The card grew by Nested's rows: it stayed where it was, shrinking in place.
      expect(await centerOf(page, views.list.folder(P("Inbox")))).toEqual(header);
      expect(await centerOf(page, views.list.child(P("Inbox/Nested")))).toEqual(nested);
      await holdsOpen(page, nested, [P("Inbox/Nested")]);
      await endDrag(page);
      await opened(page, []);
      expect((await explorer<string[]>(page, "return [...explorer.expandedPaths]")).sort()).toEqual(user.map(P).sort());
    });
  }

  test("a temporary card that starts the next column ends it, so a displaced row beside its bridge springs and takes its own drop (R=4)", async ({ page }) => {
    await listAtRows(page, 1200, 4);
    // Archive, Bulk, Empty, Inbox | drag-me, other, zeta: Empty springs into
    // column 1, so Inbox and the rows after it start column 2 (in view).
    const displaced = async () => {
      await opened(page, [P("Empty")]);
      await expect(page.locator(`${shown} .list-spring-bridge`)).toHaveCount(3);
      await settled(page);
      const card = await centerOf(page, views.list.folder(P("Empty")));
      const inbox = await centerOf(page, views.list.folder(P("Inbox")));
      // No bridge covers it.
      expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.closest("[data-spring-bridge], [data-path]")
        ?.getAttribute("data-path") ?? "a bridge", inbox)).toBe(P("Inbox"));
      expect(inbox.y).toBe(card.y);
      expect(inbox.x).toBeGreaterThan(card.x);
      return inbox;
    };
    await startDrag(page);
    await dragTo(page, views.list.folder(P("Empty")));
    // Hovering Inbox leaves Empty's peek and arms Inbox's own spring.
    expect(await dragTo(page, await displaced())).toBe(P("Inbox"));
    await opened(page, [P("Inbox")]);
    await settled(page);
    await holdsOpen(page, views.list.folder(P("Inbox")), [P("Inbox")]);
    await endDrag(page);
    await opened(page, []);
    // A drop on the displaced row lands in it, not in the bridged folder.
    await startDrag(page, "zeta.txt");
    await dragTo(page, views.list.folder(P("Empty")));
    expect(await dropOn(page, await displaced())).toBe(P("Inbox"));
    await expect.poll(() => listing(page, P("Inbox"))).toContain("zeta.txt");
    expect(await listing(page, P("Empty"))).toEqual([]);
    await endDrag(page);
    await opened(page, []);
  });

  for (const [label, width] of [["the next column in view", 900], ["a reveal scroll to the next column", 600]] as const) {
    test(`a folder in a column's last row springs into the next column, stays open over its old slot and takes a drop (${label})`, async ({ page }) => {
      await listAtRows(page, width, 4);
      // Archive, Bulk, Empty, Inbox: Inbox holds column 0's last row.
      const slot = await centerOf(page, views.list.folder(P("Inbox")));
      await startDrag(page);
      await dragTo(page, slot);
      await opened(page, [P("Inbox")]);
      // Not a header-only card: the card starts column 1 and is fully in view.
      const card = page.locator(views.list.surface(P("Inbox")));
      await expect(card).toBeVisible();
      await expect(page.locator(views.list.child(P("Inbox/alpha.txt")))).toBeVisible();
      await expect.poll(async () => page.evaluate(([cardSelector, scroller]) => {
        const a = document.querySelector(cardSelector)!.getBoundingClientRect(), b = document.querySelector(scroller)!.getBoundingClientRect();
        return a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
      }, [views.list.surface(P("Inbox")), `${shown} .list-scroller`] as const)).toBe(true);
      // The vacated slot is inside the peek, so the wrap (and its reveal) does not close it.
      expect(await dragTo(page, slot)).toMatch(new RegExp(`^(bridge:)?${P("Inbox")}$`));
      await holdsOpen(page, slot, [P("Inbox")]);
      // Sideways along the old row, then up into the card: never outside the peek.
      const alpha = await centerOf(page, views.list.child(P("Inbox/alpha.txt")));
      for (let x = slot.x; Math.abs(x - alpha.x) > 1; x += Math.sign(alpha.x - x) * Math.min(30, Math.abs(alpha.x - x))) {
        await dragTo(page, { x, y: slot.y });
        expect(await springPeeks(page)).toEqual([P("Inbox")]);
      }
      for (let y = slot.y; y > alpha.y; y -= 12) {
        expect(await dragTo(page, { x: alpha.x, y })).toMatch(new RegExp(`^(bridge:)?${P("Inbox")}(/|$)`));
        expect(await springPeeks(page)).toEqual([P("Inbox")]);
      }
      await dragTo(page, views.list.child(P("Inbox/alpha.txt")));
      await dropOn(page, views.list.child(P("Inbox/alpha.txt")));
      await expect.poll(() => listing(page, P("Inbox"))).toContain("drag-me.txt");
      await endDrag(page);
      await opened(page, []);
      // Closed, Inbox is back in column 0's last row.
      await expect(page.locator(`${shown} .list-spring-bridge`)).toHaveCount(0);
    });
  }
});

test("tiles: a stacked temporary panel is reachable through the channel around its ribbon, and the ribbon takes a drop", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 700 });
  await page.goto(`/?path=${root}&viewMode=tiles`);
  await expect(page.locator(views.tiles.folder(P("Empty")))).toBeVisible();
  // Archive's panel takes the band below the row and Bulk's the band above, so
  // Empty springs into a stacked panel whose ribbon runs beside Archive's.
  for (const folder of ["Archive", "Bulk"]) {
    await explorer(page, "return explorer.togglePeek(value)", P(folder));
    await expect(page.locator(views.tiles.surface(P(folder)))).toBeVisible();
  }
  await expect.poll(() => explorer(page, "return Object.fromEntries(explorer.tilePanelSides)"))
    .toEqual({ [P("Archive")]: "below", [P("Bulk")]: "above" });
  await expect(page.locator(`${shown} [data-motion-key][style*="transform"]`)).toHaveCount(0);
  await startDrag(page);
  await dragTo(page, views.tiles.folder(P("Empty")));
  await opened(page, [P("Empty")]);
  const ribbon = `${shown} .outline-ribbon-hit[data-spring-bridge="${P("Empty")}"]`;
  await expect(page.locator(ribbon)).toHaveCount(1);
  await expect(page.locator(views.tiles.surface(P("Empty")))).toBeVisible();
  // Down from the tile to the label beside the ribbon, 20px either side within
  // its channel (Archive's panel bounds the channel on the left): never outside the peek.
  const tile = (await page.locator(views.tiles.folder(P("Empty"))).boundingBox())!;
  const line = (await page.locator(ribbon).boundingBox())!;
  const archive = (await page.locator(views.tiles.surface(P("Archive"))).boundingBox())!;
  const centre = line.x + line.width / 2;
  for (const offset of [-Math.min(20, centre - (archive.x + archive.width) - 2), 20]) {
    for (let y = tile.y + tile.height - 4; y < line.y + line.height; y += 12) {
      expect(await dragTo(page, { x: centre + offset, y })).toMatch(new RegExp(`^(bridge:)?${P("Empty")}$`));
      expect(await springPeeks(page)).toEqual([P("Empty")]);
    }
  }
  await holdsOpen(page, { x: line.x + line.width / 2 + 20, y: line.y + line.height / 2 }, [P("Empty")]);
  // A drop on the ribbon lands in the stacked panel's folder.
  expect(await dropOn(page, { x: line.x + line.width / 2, y: line.y + line.height / 2 })).toBe(`bridge:${P("Empty")}`);
  await expect.poll(() => listing(page, P("Empty"))).toEqual(["drag-me.txt"]);
  expect(await listing(page, root)).not.toContain("drag-me.txt");
  await endDrag(page);
  await opened(page, []);
});
