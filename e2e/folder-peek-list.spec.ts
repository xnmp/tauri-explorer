import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "./fixtures";

// List cards (#1240, spec §8.3–8.4): an open top-level folder in the column
// flow is a card; its descendants scroll inside it under the fixed header.
const root = "/folder-peek-list";
const shown = ".pane-tree:not(.retained)";
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.text().includes("derived_inert") || message.text().includes("effect_update_depth")) errors.push(message.text()); });
});
test.afterEach(async ({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });

const viewport = (page: Page) => page.locator(`${shown} .list-scroller`);
const slot = (page: Page, path: string) => page.locator(`${shown} .list-slot[data-motion-key="entry:${path}"]`);
const row = (page: Page, path: string) => page.locator(`${shown} .entry-item[data-path="${path}"]`);
const caret = (page: Page, path: string) => row(page, path).locator(":scope > .peek-caret");
const card = (page: Page, path: string) => slot(page, path).locator("[data-card-scroll]");
const layer = (page: Page) => page.locator(`${shown} .list-motion-layer`);

async function open(page: Page, path = root, size?: { width: number; height: number }) {
  if (size) await page.setViewportSize(size);
  await page.goto(`/?path=${path}&viewMode=list`);
  await expect(page.locator(`${shown} .list-item`).first()).toBeVisible();
  await expect.poll(() => page.locator(`${shown} .list-view`).getAttribute("data-rows")).not.toBe("4");
  return Number(await page.locator(`${shown} .list-view`).getAttribute("data-rows"));
}
const setting = (page: Page, patch: Record<string, boolean>) => page.evaluate(async values => {
  const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
  settingsStore.update(values);
}, patch);
/** Waits until no motion is running (no ghost, no inline motion style) and
 * none starts within an animation's length afterwards. */
async function settled(page: Page) {
  const motion = () => page.evaluate(selector => {
    const pane = document.querySelector(selector)!;
    const styled = [...pane.querySelectorAll<HTMLElement>(".list-slot, [data-card-scroll]")]
      .filter(el => el.style.transform || el.style.clipPath || el.style.visibility || (el.matches("[data-card-scroll]") && el.style.height));
    return pane.querySelector(".list-motion-layer")!.childElementCount + styled.length;
  }, shown);
  await expect.poll(motion, { timeout: 3000 }).toBe(0);
  await page.waitForTimeout(250);
  await expect.poll(motion, { timeout: 3000 }).toBe(0);
}
const explorerCall = <T>(page: Page, body: string, arg?: unknown) => page.evaluate(async ([source, value]) => {
  const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
  return new Function("explorer", "value", source)(windowTabsManager.getActiveExplorer()!, value);
}, [body, arg] as const) as Promise<T>;
/** Column and row of each mounted top-level item. */
const placements = (page: Page) => page.locator(`${shown} .list-slot`).evaluateAll(slots => Object.fromEntries(slots.map(el => {
  const element = el as HTMLElement;
  return [element.dataset.motionKey!.slice("entry:".length), [Number(element.dataset.column), element.offsetTop / 30]];
})));
/** Clicks a folder's caret and waits until its peek has settled. */
async function toggle(page: Page, path: string) {
  const open = await row(page, path).getAttribute("aria-expanded") === "true";
  await caret(page, path).click();
  await expect(row(page, path)).toHaveAttribute("aria-expanded", String(!open));
  await expect.poll(() => explorerCall<string>(page, "return explorer.peekStatus(value) ?? 'none'", path)).not.toBe("loading");
  await settled(page);
}

test("opening shows a card in its column and shifts every later item by its rows", async ({ page }) => {
  const R = await open(page);
  const before = await placements(page);
  expect(before[`${root}/Career`]).toEqual([0, 2]);
  await toggle(page, `${root}/Career`);
  const after = await placements(page);
  // Career has 9 children: 6 visible rows (the default), a 7-slot card.
  await expect(card(page, `${root}/Career`)).toHaveCSS("height", "180px");
  await expect(card(page, `${root}/Career`)).toHaveAttribute("aria-label", "Career contents");
  await expect(card(page, `${root}/Career`)).toHaveAttribute("role", "group");
  await expect(card(page, `${root}/Career`).locator(".entry-item")).not.toHaveCount(0);
  const linear = ([column, slotRow]: number[]) => column * R + slotRow;
  for (const [path, place] of Object.entries(before)) {
    if (!(path in after)) continue;
    const shift = linear(place) > linear(before[`${root}/Career`]) ? 6 : 0;
    expect([path, linear(after[path])]).toEqual([path, linear(place) + shift]);
  }
  // Children are entries of the pane, not top-level slots.
  expect(Object.keys(after).some(path => path.startsWith(`${root}/Career/`))).toBe(false);
  // The pane's own item count is unchanged by a peek.
  await expect(page.locator(".status-bar").first()).toContainText("90 items");
});

test("a card that does not fit starts the next column, leaving a gap, and is scrolled into view", async ({ page }) => {
  const R = await open(page, root, { width: 720, height: 430 });
  expect(R).toBeLessThan(12);
  expect(await viewport(page).evaluate(el => el.scrollLeft)).toBe(0);
  await toggle(page, `${root}/Personal`);
  const after = await placements(page);
  expect(after[`${root}/Personal`]).toEqual([1, 0]);
  expect(after[`${root}/Inbox`]).toEqual([0, 4]);
  // Nothing fills the tail gap the wrapped card left in column 0.
  expect(Object.values(after).filter(([column, slotRow]) => column === 0 && slotRow > 4)).toEqual([]);
  // The whole card is inside the scrollport once its motion has settled.
  await expect.poll(async () => {
    const [box, port] = await Promise.all([slot(page, `${root}/Personal`).boundingBox(), viewport(page).boundingBox()]);
    return box!.x >= port!.x - 1 && box!.x + box!.width <= port!.x + port!.width + 1;
  }).toBe(true);
  expect(await viewport(page).evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
});

test("nested folders open inside the card with guide lines, the close caret and a fixed header", async ({ page }) => {
  await open(page);
  await toggle(page, `${root}/Career`);
  const codex = (await placements(page))[`${root}/Codex`];
  await toggle(page, `${root}/Career/Applications`);
  const acme = row(page, `${root}/Career/Applications/Acme Corp`);
  await expect(card(page, `${root}/Career`).locator(`.entry-item[data-path="${root}/Career/Applications/Acme Corp"]`)).toBeVisible();
  // The card's height is unchanged (still 6 visible rows): nothing outside moved.
  expect((await placements(page))[`${root}/Codex`]).toEqual(codex);
  await expect(acme).toHaveAttribute("aria-level", "3");
  await expect(row(page, `${root}/Career/Applications`)).toHaveAttribute("aria-expanded", "true");
  await expect(slot(page, `${root}/Career`).locator(".list-guide")).toHaveCount(1);
  // Close caret: 14px slot, 10px chevron, 16px per level, a child's caret under its parent's icon.
  const geometry = await page.evaluate(([parent, child]) => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const p = `.pane-tree:not(.retained) .entry-item[data-path="${parent}"]`, c = `.pane-tree:not(.retained) .entry-item[data-path="${child}"]`;
    const guide = document.querySelector(".pane-tree:not(.retained) .list-guide")!.getBoundingClientRect();
    // The chevron is the caret button's centred ::before.
    const chevron = (row: string) => {
      const button = document.querySelector(`${row} .peek-caret`)!;
      const box = button.getBoundingClientRect(), style = getComputedStyle(button, "::before");
      const left = box.left + (box.width - parseFloat(style.width)) / 2;
      return { left, right: left + parseFloat(style.width), width: parseFloat(style.width), height: parseFloat(style.height), turned: style.transform };
    };
    return {
      slot: rect(`${p} .peek-caret`).width, chevron: chevron(p).width, chevronHeight: chevron(p).height,
      gap: rect(`${p} .list-icon`).left - chevron(p).right,
      fileIcon: rect(`.pane-tree:not(.retained) .entry-item[data-path="${parent}/follow-ups.md"] .list-icon`).left - rect(`${c} .list-icon`).left,
      indent: rect(`${c} .peek-caret`).left - rect(`${p} .peek-caret`).left,
      underIcon: Math.abs((chevron(c).left + 5) - (rect(`${p} .list-icon`).left + 8)),
      guideUnderCaret: Math.abs(guide.left + guide.width / 2 - (chevron(p).left + 5)),
      // Open points down (a quarter turn), closed points right.
      open: chevron(p).turned, closed: chevron(c).turned,
    };
  }, [`${root}/Career/Applications`, `${root}/Career/Applications/Acme Corp`]);
  expect(geometry).toMatchObject({ slot: 14, chevron: 10, chevronHeight: 10, indent: 16, gap: 4, closed: "none" });
  expect(geometry.open).toMatch(/^matrix\((?:[-\d.e]+), 1, -1, (?:[-\d.e]+), 0, 0\)$/);
  expect(geometry.fileIcon).toBe(0); // a file row keeps the caret gutter, so names align
  expect(geometry.underIcon).toBeLessThanOrEqual(2);
  expect(geometry.guideUnderCaret).toBeLessThanOrEqual(1);
  // Scrolling the card moves its descendants under the header, which stays put.
  const header = await row(page, `${root}/Career`).boundingBox();
  const first = await row(page, `${root}/Career/Applications`).boundingBox();
  await card(page, `${root}/Career`).evaluate(el => { el.scrollTop = 60; });
  await expect.poll(async () => (await row(page, `${root}/Career/Applications`).boundingBox())?.y ?? -1).toBeCloseTo(first!.y - 60, 0);
  expect(await row(page, `${root}/Career`).boundingBox()).toEqual(header);
});

test("assistive technology reads the List as a tree, with sibling positions, inside open cards", async ({ page }) => {
  // Carets, the card group, its grip (inside the folder's treeitem) and pseudo-rows
  // are all valid tree content. Contrast has its own per-theme scan. A card's
  // scroll area is deliberately not a tab stop (tabindex -1): the tree's roving
  // cursor reaches and scrolls every card row (the Up/Down test), which axe's
  // scrollable-region-focusable cannot see, since roving rows carry tabindex -1.
  const violations = async () => (await new AxeBuilder({ page }).include(`${shown} .list-view`)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).disableRules(["color-contrast", "scrollable-region-focusable"]).analyze())
    .violations.map(v => `${v.id}: ${v.nodes.map(n => `${n.target.join(" ")} (${n.failureSummary})`).join(", ")}`);
  await open(page);
  await expect(viewport(page)).toHaveAttribute("role", "tree");
  await toggle(page, `${root}/Career`);
  await toggle(page, `${root}/Career/Portfolio`); // empty: an "Empty folder" pseudo-row
  const empty = slot(page, `${root}/Career`).locator(".list-peek-state", { hasText: "Empty folder" });
  await expect(empty).toHaveAttribute("role", "treeitem");
  await expect(empty).toHaveAttribute("aria-level", "3");
  // The card's group sits beside its header, which owns it, yet is named alone.
  const group = await card(page, `${root}/Career`).getAttribute("id");
  expect(group).toBeTruthy();
  await expect(row(page, `${root}/Career`)).toHaveAttribute("aria-owns", group!);
  await expect(row(page, `${root}/Career`)).toHaveAccessibleName("Career");
  expect(await row(page, `${root}/Career`).ariaSnapshot()).toContain('group "Career contents"');
  await expect(row(page, `${root}/Inbox`)).not.toHaveAttribute("aria-owns");
  expect(await violations()).toEqual([]);
  await toggle(page, `${root}/Career/Applications`);
  // Positions count siblings under the same parent, not the global entry index.
  await expect(row(page, `${root}/Career/Applications`)).toHaveAttribute("aria-posinset", "1");
  await expect(row(page, `${root}/Career/Applications`)).toHaveAttribute("aria-setsize", "9");
  const globex = row(page, `${root}/Career/Applications/Globex`);
  await expect(globex).toHaveAttribute("role", "treeitem");
  await expect(globex).toHaveAttribute("aria-level", "3");
  await expect(globex).toHaveAttribute("aria-expanded", "false");
  await expect(globex).toHaveAttribute("aria-posinset", "2");
  await expect(globex).toHaveAttribute("aria-setsize", "5");
  await expect(row(page, `${root}/Career/Applications/follow-ups.md`)).not.toHaveAttribute("aria-expanded");
  expect(await violations()).toEqual([]);
  // An open card adds one Tab stop, its grip (the separator's only keyboard
  // path); its scroll area is not one, since the tree's cursor reaches every row.
  await row(page, `${root}/Career`).click();
  await page.keyboard.press("Tab");
  await expect(slot(page, `${root}/Career`).getByRole("separator", { name: "Resize Career" })).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest(".list-slot"))).toBe(false);
});

test("a rename inside a card commits in place and the card keeps its rows", async ({ page }) => {
  await open(page);
  await toggle(page, `${root}/Inbox`);
  await row(page, `${root}/Inbox/quote.txt`).click();
  await page.keyboard.press("F2");
  const editor = page.locator(".rename-input");
  await editor.fill("a-quote.txt");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  await expect(card(page, `${root}/Inbox`).locator(`.entry-item[data-path="${root}/Inbox/a-quote.txt"]`)).toBeVisible();
  await expect(card(page, `${root}/Inbox`).locator(".entry-item")).toHaveCount(6);
});

test("a card's own surface takes drops for its folder, and its file rows retire that feedback", async ({ page }) => {
  await open(page);
  await toggle(page, `${root}/Career`);
  await toggle(page, `${root}/Career/Portfolio`); // empty: an "Empty folder" pseudo-row
  const empty = card(page, `${root}/Career`).locator(`.list-peek-state[data-path="${root}/Career/Portfolio"]`);
  await expect(empty).toHaveText("Empty folder");
  const portfolio = row(page, `${root}/Career/Portfolio`);
  const drag = (selector: string, types: string[]) => page.evaluate(async ([target, events]) => {
    const { createHtml5FileDrag } = await import("/src/lib/state/html5-file-drag.svelte.ts");
    const w = window as unknown as { __fplDrag?: DataTransfer };
    if (!w.__fplDrag) {
      w.__fplDrag = new DataTransfer();
      createHtml5FileDrag().start(new DragEvent("dragstart", { dataTransfer: w.__fplDrag }), { path: "/home/user/notes.md", name: "notes.md", kind: "file" });
    }
    const element = document.querySelector(target)!;
    for (const type of events) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: w.__fplDrag }));
  }, [selector, types] as const);
  const emptySelector = `${shown} .list-peek-state[data-path="${root}/Career/Portfolio"]`;
  await drag(emptySelector, ["dragenter", "dragover"]);
  await expect(portfolio).toHaveClass(/drop-target/);
  await expect(page.locator(`${shown} .content.drop-target, ${shown} .file-list.drop-target`)).toHaveCount(0);
  await drag(`${shown} .entry-item[data-path="${root}/Career/headshot.jpg"]`, ["dragenter", "dragover"]);
  await expect(portfolio).not.toHaveClass(/drop-target/);
  await drag(emptySelector, ["dragover", "drop"]);
  await expect(page.locator(".toast").filter({ hasText: /Moved/ })).toHaveCount(1);
  // The move reached the nested folder whose pseudo-row took the drop. (Peek
  // listings are not refreshed by a mock-backend move; Details behaves the same.)
  expect(await page.evaluate(async () => (await import("/src/lib/api/mock-fixtures.ts")).mockFiles["/folder-peek-list/Career/Portfolio"].map(entry => entry.name))).toEqual(["notes.md"]);
  await expect(portfolio).not.toHaveClass(/drop-target/);
});

test("the grip resizes in whole rows, previews only its card, is remembered and never exceeds a column", async ({ page }) => {
  const R = await open(page);
  await toggle(page, `${root}/Archive`);
  const grip = slot(page, `${root}/Archive`).getByRole("separator", { name: "Resize Archive" });
  await expect(grip).toHaveAttribute("aria-valuenow", "6");
  await expect(grip).toHaveAttribute("aria-valuemax", String(Math.floor(0.7 * R)));
  // Pressing the grip, which sits inside the folder's draggable row, never starts a file drag.
  await page.evaluate(() => {
    (window as unknown as { fileDrags: number }).fileDrags = 0;
    document.addEventListener("dragstart", event => { if (!event.defaultPrevented) (window as unknown as { fileDrags: number }).fileDrags++; });
  });
  const before = await placements(page);
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 4 }); // 1.33 rows
  // Only the card's scroll area previews; the layout has not moved.
  await expect(card(page, `${root}/Archive`)).toHaveCSS("height", "210px");
  expect(await placements(page)).toEqual(before);
  await expect(slot(page, `${root}/Career`)).toHaveClass(/covered/);
  await page.mouse.up();
  await settled(page);
  await expect(grip).toHaveAttribute("aria-valuenow", "7");
  expect((await placements(page))[`${root}/Career`]).toEqual([before[`${root}/Career`][0], before[`${root}/Career`][1] + 1]);
  await expect(slot(page, `${root}/Career`)).not.toHaveClass(/covered/);
  // Remembered across collapse and re-open.
  await toggle(page, `${root}/Archive`);
  await toggle(page, `${root}/Archive`);
  await expect(card(page, `${root}/Archive`)).toHaveCSS("height", "210px");
  // Dragging far caps the card at floor(0.7R) rows: it always fits one column.
  const far = (await grip.boundingBox())!;
  await page.mouse.move(far.x + far.width / 2, far.y + far.height / 2);
  await page.mouse.down();
  await page.mouse.move(far.x + far.width / 2, far.y + 4000, { steps: 4 });
  await page.mouse.up();
  await settled(page);
  await expect(grip).toHaveAttribute("aria-valuenow", String(Math.floor(0.7 * R)));
  expect(await slot(page, `${root}/Archive`).evaluate(el => el.offsetHeight)).toBeLessThanOrEqual(R * 30);
  // Separator keys: one row per arrow, Home/End for the minimum and maximum.
  await grip.focus();
  await page.keyboard.press("ArrowUp");
  await expect(grip).toHaveAttribute("aria-valuenow", String(Math.floor(0.7 * R) - 1));
  await page.keyboard.press("Home");
  await expect(grip).toHaveAttribute("aria-valuenow", "1");
  await page.keyboard.press("End");
  await expect(grip).toHaveAttribute("aria-valuenow", String(Math.floor(0.7 * R)));
  // The grip lives inside the folder's treeitem, yet pressing it never selects or
  // toggles that folder, even with carets off, where a row click toggles.
  await setting(page, { folderPeekCarets: false });
  const still = (await grip.boundingBox())!;
  await page.mouse.click(still.x + still.width / 2, still.y + still.height / 2);
  await settled(page);
  await expect(row(page, `${root}/Archive`)).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, `${root}/Archive`)).not.toHaveClass(/selected/);
  await expect(grip).toHaveAttribute("aria-valuenow", String(Math.floor(0.7 * R)));
  expect(await page.evaluate(() => (window as unknown as { fileDrags: number }).fileDrags)).toBe(0);
});

test("a grip resize stays in its column, so the card never moves, and a press leaves focus where it was", async ({ page }) => {
  // R = 10 with Codex at [0,3]: six rows remain below its header, fewer than floor(0.7R).
  const first = await open(page, root, { width: 720, height: 430 });
  await page.setViewportSize({ width: 720, height: 430 + (10 - first) * 30 });
  await expect(page.locator(`${shown} .list-view`)).toHaveAttribute("data-rows", "10");
  await toggle(page, `${root}/Codex`);
  expect((await placements(page))[`${root}/Codex`]).toEqual([0, 3]);
  const grip = slot(page, `${root}/Codex`).getByRole("separator", { name: "Resize Codex" });
  await expect(grip).toHaveAttribute("aria-valuemax", "6");
  await row(page, `${root}/Codex`).click();
  await expect(row(page, `${root}/Codex`)).toBeFocused();
  const bottom = async () => {
    const [box, port] = await Promise.all([card(page, `${root}/Codex`).boundingBox(), viewport(page).boundingBox()]);
    return box!.y + box!.height - (port!.y + port!.height);
  };
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 4000, { steps: 4 });
  // The preview stops at the column's bottom edge.
  await expect(grip).toHaveAttribute("aria-valuenow", "6");
  expect(await bottom()).toBeLessThanOrEqual(1);
  await page.mouse.up();
  await settled(page);
  expect((await placements(page))[`${root}/Codex`]).toEqual([0, 3]);
  expect(await inView(page, `${root}/Codex`)).toBe(true);
  expect(await bottom()).toBeLessThanOrEqual(1);
  await expect(row(page, `${root}/Codex`)).toBeFocused();
  // The keyboard stops at the same clamp.
  await grip.focus();
  await page.keyboard.press("ArrowUp");
  await expect(grip).toHaveAttribute("aria-valuenow", "5");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowDown");
  await expect(grip).toHaveAttribute("aria-valuenow", "6");
  await settled(page);
  expect((await placements(page))[`${root}/Codex`]).toEqual([0, 3]);
});

test("a grip drag whose column scrolls away mid-drag still commits on release and leaves no preview", async ({ page }) => {
  await open(page, root, { width: 720, height: 430 });
  await toggle(page, `${root}/Archive`);
  const grip = slot(page, `${root}/Archive`).getByRole("separator", { name: "Resize Archive" });
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40, { steps: 4 }); // 1.33 rows
  await expect(slot(page, `${root}/Career`)).toHaveClass(/covered/);
  // A sideways scroll unmounts column 0, grip and all, while the button is held.
  await viewport(page).evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(slot(page, `${root}/Archive`)).toHaveCount(0);
  await page.mouse.up();
  await viewport(page).evaluate(el => { el.scrollLeft = 0; });
  await expect(slot(page, `${root}/Archive`)).toBeVisible();
  await settled(page);
  await expect(page.locator(`${shown} .list-slot.covered`)).toHaveCount(0);
  await expect(page.locator(`${shown} .list-card-grip.dragging`)).toHaveCount(0);
  expect(await explorerCall<number | undefined>(page, "return explorer.listCardRows(value)", `${root}/Archive`)).toBe(7);
  await expect(grip).toHaveAttribute("aria-valuenow", "7");
  await expect(card(page, `${root}/Archive`)).toHaveCSS("height", "210px");
});

test("+N more counts rows below the visible area and fade masks follow the scrolled edges", async ({ page }) => {
  await open(page);
  await toggle(page, `${root}/Archive`); // 50 rows, 6 visible
  const scroller = card(page, `${root}/Archive`);
  const more = slot(page, `${root}/Archive`).locator(".list-card-more");
  const fades = () => scroller.evaluate(el => [getComputedStyle(el).getPropertyValue("--fade-top").trim(), getComputedStyle(el).getPropertyValue("--fade-bottom").trim()]);
  await expect(more).toHaveText("+44 more");
  expect(await fades()).toEqual(["0px", "28px"]);
  await scroller.evaluate(el => { el.scrollTop = 300; });
  await expect(more).toHaveText("+34 more");
  await expect.poll(fades).toEqual(["28px", "28px"]);
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(more).toHaveCount(0);
  await expect.poll(fades).toEqual(["28px", "0px"]);
  // A card whose content fits shows neither.
  await toggle(page, `${root}/Inbox`); // 6 rows
  await expect(slot(page, `${root}/Inbox`).locator(".list-card-more")).toHaveCount(0);
  expect(await card(page, `${root}/Inbox`).evaluate(el => getComputedStyle(el).getPropertyValue("--fade-bottom").trim())).toBe("0px");
});

test("Up/Down pass through a card's rows, scrolling the card, and stop at column ends", async ({ page }) => {
  await open(page);
  await toggle(page, `${root}/Archive`);
  await row(page, `${root}/Archive`).click();
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowDown");
  // Folders 2019..2023 then archive-01..04: content offset 8.
  const target = row(page, `${root}/Archive/archive-04.pdf`);
  await expect(target).toBeFocused();
  await expect(target).toHaveClass(/selected/);
  expect(await card(page, `${root}/Archive`).evaluate(el => el.scrollTop)).toBe(90);
  const [rect, clip] = await Promise.all([target.boundingBox(), card(page, `${root}/Archive`).boundingBox()]);
  expect(rect!.y).toBeGreaterThanOrEqual(clip!.y - 1);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(clip!.y + clip!.height + 1);
  for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowUp");
  await expect(row(page, `${root}/Archive`)).toBeFocused();
  expect(await card(page, `${root}/Archive`).evaluate(el => el.scrollTop)).toBe(0);
  await page.keyboard.press("ArrowUp");
  await expect(row(page, `${root}/AI Draft Archive`)).toBeFocused();
  // Left/Right stay spatial: from a card row to the same on-screen row.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown"); // 2019, card slot row 2
  await page.keyboard.press("ArrowRight");
  const focusedTop = await page.evaluate(() => (document.activeElement as HTMLElement).getBoundingClientRect().top);
  const fromTop = await row(page, `${root}/Archive/2019`).evaluate(el => el.getBoundingClientRect().top);
  expect(Math.abs(focusedTop - fromTop)).toBeLessThanOrEqual(1);
});

test("a vertical wheel over a card scrolls the card first, then the List sideways", async ({ page }) => {
  await open(page);
  await toggle(page, `${root}/Archive`);
  const scroller = card(page, `${root}/Archive`);
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await viewport(page).evaluate(el => el.scrollLeft)).toBe(0);
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.mouse.wheel(0, 120);
  await expect.poll(() => viewport(page).evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  // Ctrl+wheel is never taken by the card or the List.
  const prevented = await scroller.evaluate(el => {
    const event = new WheelEvent("wheel", { deltaY: -40, ctrlKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
});

test("with carets off a click toggles a folder, nested rows have no caret, and Enter (not double-click) navigates", async ({ page }) => {
  await open(page);
  await setting(page, { folderPeekCarets: false });
  await expect(page.locator(`${shown} .peek-caret`)).toHaveCount(0);
  // Without carets the gutter goes too: the icon starts at the row's padding.
  expect(await row(page, `${root}/Career`).evaluate(el => el.querySelector(".list-icon")!.getBoundingClientRect().left - el.getBoundingClientRect().left)).toBe(11);
  await row(page, `${root}/Career`).click();
  await expect(card(page, `${root}/Career`)).toBeVisible();
  await expect(row(page, `${root}/Career`)).toHaveAttribute("aria-expanded", "true");
  await row(page, `${root}/Career/Applications`).click();
  await expect(row(page, `${root}/Career/Applications/Globex`)).toBeVisible();
  await expect(card(page, `${root}/Career`).locator(".peek-caret")).toHaveCount(0);
  await row(page, `${root}/Career`).click();
  await expect(card(page, `${root}/Career`)).toHaveCount(0);
  await row(page, `${root}/Inbox`).click();
  await expect(card(page, `${root}/Inbox`)).toBeVisible();
  const expanded = () => explorerCall<string[]>(page, "return [...explorer.expandedPaths]");
  const was = await expanded();
  expect(was).toContain(`${root}/Inbox`); // a closed card remembers its nested peeks
  // A double-click is two toggles here, so it stays put and explains the key (#1298).
  await row(page, `${root}/Codex`).dblclick();
  await expect(page.locator(".toast.info").filter({ hasText: "Use Enter to navigate into folders" })).toHaveCount(1);
  await expect(card(page, `${root}/Codex`)).toHaveCount(0);
  expect(await explorerCall<string>(page, "return explorer.currentPath")).toBe(root);
  await page.keyboard.press("Enter");
  await expect(page.locator(`${shown} .entry-item[data-path="${root}/Codex/AGENTS.md"]`)).toBeVisible();
  await explorerCall(page, "return explorer.goBack()");
  await expect(row(page, `${root}/Codex`)).toBeVisible();
  expect(await expanded()).toEqual(was);
  await expect(card(page, `${root}/Inbox`)).toBeVisible();
});

test("with Folder Peek off List is the classic row-major grid without cards", async ({ page }) => {
  await open(page);
  await toggle(page, `${root}/Career`);
  await setting(page, { folderPeek: false });
  await expect(page.locator(`${shown} .list-view[data-columns]`)).toBeVisible();
  await expect(page.locator(`${shown} .list-motion-layer, ${shown} [data-card-scroll], ${shown} .peek-caret`)).toHaveCount(0);
  await expect(row(page, `${root}/Career/Applications`)).toHaveCount(0);
  await row(page, `${root}/Career`).click();
  await expect(row(page, `${root}/Career/Applications`)).toHaveCount(0);
  await setting(page, { folderPeek: true });
  await expect(page.locator(`${shown} .list-scroller .peek-caret`).first()).toBeVisible();
});

/** Whether a slot lies horizontally inside the List's scrollport. */
const inView = (page: Page, path: string) => slot(page, path).evaluate(el => {
  const port = el.closest(".list-scroller")!.getBoundingClientRect(), box = el.getBoundingClientRect();
  return box.left >= port.left - 0.5 && box.right <= port.right + 0.5;
});
const activePath = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.path ?? document.activeElement?.tagName ?? null);

test("closing a card keeps keyboard focus on its header: caret, carets-off click and Escape", async ({ page }) => {
  await open(page);
  // Caret click on the focused header.
  await row(page, `${root}/Career`).click();
  await toggle(page, `${root}/Career`);
  await expect.poll(() => activePath(page)).toBe(`${root}/Career`);
  await toggle(page, `${root}/Career`);
  expect(await activePath(page)).toBe(`${root}/Career`);
  // Escape from a nested row closes its card and lands on the header.
  await toggle(page, `${root}/Archive`);
  await row(page, `${root}/Archive/2019`).click();
  await expect.poll(() => activePath(page)).toBe(`${root}/Archive/2019`);
  await page.keyboard.press("Escape"); // clears the selection
  await expect(page.locator(`${shown} .entry-item.selected`)).toHaveCount(0);
  await page.keyboard.press("Escape"); // steps out: closes the card, cursor on its header
  await expect(row(page, `${root}/Archive`)).toHaveAttribute("aria-expanded", "false");
  await settled(page);
  expect(await activePath(page)).toBe(`${root}/Archive`);
  // Carets off: a plain click opens, a second click closes.
  await setting(page, { folderPeekCarets: false });
  await row(page, `${root}/Codex`).click();
  await expect(row(page, `${root}/Codex`)).toHaveAttribute("aria-expanded", "true");
  await settled(page);
  await row(page, `${root}/Codex`).click();
  await expect(row(page, `${root}/Codex`)).toHaveAttribute("aria-expanded", "false");
  await settled(page);
  expect(await activePath(page)).toBe(`${root}/Codex`);
});

test("a card that wraps once its slow listing settles is revealed, though motion has stopped", async ({ page }) => {
  await open(page, root, { width: 720, height: 430 });
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    getMockControl().latency = { list_directory_fresh: 2500 };
  });
  await caret(page, `${root}/Personal`).click();
  // Past the motion window (1.5s) the card still fits at [0,5] with its Loading row.
  await page.waitForTimeout(1700);
  expect((await placements(page))[`${root}/Personal`]).toEqual([0, 5]);
  await expect.poll(() => explorerCall<string>(page, "return explorer.peekStatus(value) ?? 'none'", `${root}/Personal`), { timeout: 8000 }).toBe("loaded");
  await settled(page);
  expect((await placements(page))[`${root}/Personal`]).toEqual([1, 0]);
  await expect.poll(() => inView(page, `${root}/Personal`)).toBe(true);
});

test("an open whose motion a layout change interrupts is still revealed", async ({ page }) => {
  // Fake time: the motion advances only when the test runs the clock, so the
  // refresh lands mid-motion however slowly the runner serves it (a wall-clock
  // bound around the refresh failed on loaded CI WebKit).
  await page.clock.install();
  await open(page, root, { width: 720, height: 430 });
  const path = `${root}/Personal`;
  await page.evaluate(async () => {
    await import("/src/lib/api/mock-fixtures.ts");
    await import("/src/lib/state/window-tabs.svelte.ts");
  });
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const moving = () => page.evaluate(selector => {
    const pane = document.querySelector(selector)!;
    return !!pane.querySelector(".list-motion-layer")!.childElementCount || [...pane.querySelectorAll<HTMLElement>(".list-slot")].some(el => el.style.transform);
  }, shown);
  await page.evaluate(([selector, target]) => {
    (document.querySelector(selector)!.querySelector(`.entry-item[data-path="${target}"] .peek-caret`) as HTMLElement).click();
  }, [shown, path] as const);
  // Some of the open's work (a lazy import) runs on real time: poll in real
  // time, stepping fake time 2ms per poll so the motion cannot run out.
  const step = async <T>(probe: () => Promise<T>) => { await page.clock.runFor(2); return probe(); };
  await expect.poll(() => step(moving), { intervals: [25], timeout: 10_000 }).toBe(true);
  const startedAt = await page.evaluate(() => performance.now());
  // A refresh that adds a file after every folder changes the layout under the motion.
  await page.evaluate(async target => {
    const { mockFiles } = await import("/src/lib/api/mock-fixtures.ts");
    const parent = target.slice(0, target.lastIndexOf("/"));
    mockFiles[parent] = [...mockFiles[parent], { ...mockFiles[parent].at(-1)!, name: "zz-late.txt", path: `${parent}/zz-late.txt` }];
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const probe = window as unknown as { refreshed?: boolean };
    probe.refreshed = false;
    void windowTabsManager.getActiveExplorer()!.refresh().then(() => { probe.refreshed = true; });
  }, path);
  const refreshed = () => page.evaluate(() => (window as unknown as { refreshed?: boolean }).refreshed === true);
  await expect.poll(() => step(refreshed), { intervals: [25], timeout: 10_000 }).toBe(true);
  const interrupted = await page.evaluate(([selector, started]) => {
    const pane = document.querySelector(selector)!;
    const running = !!pane.querySelector(".list-motion-layer")!.childElementCount || [...pane.querySelectorAll<HTMLElement>(".list-slot")].some(el => el.style.transform);
    // The motion lasts LIST_MOTION_MS (200ms): stopping well before it is a cut, not a natural end.
    return { refreshed: (window as unknown as { refreshed?: boolean }).refreshed === true, cut: performance.now() - started < 150, stopped: !running };
  }, [shown, startedAt] as const);
  expect(interrupted).toEqual({ refreshed: true, cut: true, stopped: true });
  await page.clock.resume();
  await settled(page);
  expect((await placements(page))[path]).toEqual([1, 0]);
  await expect.poll(() => inView(page, path)).toBe(true);
});

test("only visible columns animate, with sanitized ghosts on the conveyor and an instant reduced-motion path", async ({ page }) => {
  await open(page, root, { width: 720, height: 430 });
  // Sample the first animation frames after a user toggle.
  const sample = () => page.evaluate(async ([selector, path]) => {
    const pane = document.querySelector(selector)!;
    const port = pane.querySelector<HTMLElement>(".list-scroller")!;
    (pane.querySelector(`.entry-item[data-path="${path}"] .peek-caret`) as HTMLElement).click();
    const frames: { ghosts: number; ghostIdentity: number; moving: number[]; offscreenMoving: number }[] = [];
    for (let i = 0; i < 6; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const ghosts = [...pane.querySelector(".list-motion-layer")!.children] as HTMLElement[];
      const moving = [...pane.querySelectorAll<HTMLElement>(".list-slot")].filter(el => el.style.transform);
      const right = port.scrollLeft + port.clientWidth;
      frames.push({
        ghosts: ghosts.length,
        ghostIdentity: ghosts.filter(g => g.matches(".entry-item, [data-path], [data-index], [role], [tabindex]") || g.querySelector(".entry-item, .list-item, [data-path], [data-index], [role], [tabindex], [data-card-scroll]")).length,
        moving: moving.map(el => Number(el.dataset.column)),
        offscreenMoving: moving.filter(el => el.offsetLeft > right + 8).length,
      });
    }
    return frames;
  }, [shown, `${root}/Career`] as const);
  const frames = await sample();
  expect(frames.some(frame => frame.moving.length > 0)).toBe(true);
  expect(frames.some(frame => frame.ghosts > 0)).toBe(true); // items leaving column 0 at its bottom
  expect(frames.every(frame => frame.ghostIdentity === 0 && frame.offscreenMoving === 0)).toBe(true);
  await settled(page);
  // Reduced motion: the next frame already shows the final layout.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await sample();
  expect(reduced.every(frame => frame.moving.length === 0 && frame.ghosts === 0)).toBe(true);
  await expect(card(page, `${root}/Career`)).toHaveCount(0);
});

test("motion stays inside the scrollport on both sides: columns wholly off either edge never animate", async ({ page }) => {
  await open(page, root, { width: 720, height: 430 });
  await toggle(page, `${root}/Career`);
  // Columns 0 and 1 lie wholly off the left edge, column 2 straddles it, and
  // columns past the right edge are still mounted (overscan).
  await viewport(page).evaluate(el => { el.scrollLeft = 2 * 276 + 100; });
  // The List has taken the scroll once columns past the first window mount
  // (column 0 stays mounted as overscan).
  await expect.poll(() => page.locator(`${shown} .list-slot[data-column="5"]`).count()).toBeGreaterThan(0);
  await expect.poll(() => page.locator(`${shown} .list-slot[data-column="0"]`).count()).toBeGreaterThan(0);
  // Collapsing Career moves every later item up six rows, in every column.
  const frames = await page.evaluate(async selector => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const pane = document.querySelector(selector)!;
    const scroller = pane.querySelector<HTMLElement>(".list-scroller")!;
    const canvas = pane.querySelector<HTMLElement>(".list-canvas")!;
    const box = scroller.getBoundingClientRect();
    const port = { left: box.left + scroller.clientLeft, right: box.left + scroller.clientLeft + scroller.clientWidth };
    const intersects = (left: number, right: number) => right > port.left && left < port.right;
    windowTabsManager.getActiveExplorer()!.collapseAllPeeks();
    const out: { moving: number; strayMoving: string[]; strayGhosts: number; ghosts: number; offLeft: number; offRight: number; edgeMoving: number }[] = [];
    for (let i = 0; i < 6; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const origin = canvas.getBoundingClientRect().left;
      const slots = [...pane.querySelectorAll<HTMLElement>(".list-slot")];
      const ghosts = [...pane.querySelector(".list-motion-layer")!.children] as HTMLElement[];
      // A slot's layout box (without its transform), and its drawn box.
      const layout = (el: HTMLElement) => ({ left: origin + el.offsetLeft, right: origin + el.offsetLeft + el.offsetWidth });
      const moving = slots.filter(el => el.style.transform || el.style.clipPath);
      out.push({
        moving: moving.length,
        strayMoving: moving.filter(el => {
          const drawn = el.getBoundingClientRect(), placed = layout(el);
          return !intersects(drawn.left, drawn.right) || !intersects(placed.left, placed.right);
        }).map(el => el.dataset.motionKey!),
        strayGhosts: ghosts.filter(el => { const r = el.getBoundingClientRect(); return !intersects(r.left, r.right); }).length,
        ghosts: ghosts.length,
        offLeft: slots.filter(el => layout(el).right <= port.left).length,
        offRight: slots.filter(el => layout(el).left >= port.right).length,
        edgeMoving: moving.filter(el => layout(el).left < port.left).length,
      });
    }
    return out;
  }, shown);
  expect(frames.some(frame => frame.moving > 0)).toBe(true);
  // The column straddling the left edge animates; nothing wholly outside does.
  expect(frames.some(frame => frame.edgeMoving > 0)).toBe(true);
  expect(frames.every(frame => frame.offLeft > 0 && frame.offRight > 0)).toBe(true);
  expect(frames.flatMap(frame => frame.strayMoving)).toEqual([]);
  expect(frames.every(frame => frame.strayGhosts === 0)).toBe(true);
  await settled(page);
});

test("refresh, navigation and a row-count change re-lay the List out instantly, while a user toggle animates", async ({ page }) => {
  await open(page, root, { width: 720, height: 430 });
  /** Starts recording, per animation frame, how many elements carry motion. */
  const record = () => page.evaluate(selector => {
    const w = window as unknown as { motion: number[] };
    w.motion = [];
    const tick = () => {
      const pane = document.querySelector(selector);
      const styled = pane ? [...pane.querySelectorAll<HTMLElement>(".list-slot, [data-card-scroll]")]
        .filter(el => el.style.transform || el.style.clipPath || el.style.visibility || (el.matches("[data-card-scroll]") && el.style.height)) : [];
      w.motion.push((pane?.querySelector(".list-motion-layer")?.childElementCount ?? 0) + styled.length);
      if (w.motion.length < 30) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, shown);
  const recorded = async () => {
    await expect.poll(() => page.evaluate(() => (window as unknown as { motion: number[] }).motion.length)).toBe(30);
    return page.evaluate(() => (window as unknown as { motion: number[] }).motion);
  };
  // Positive control: the same probe sees a user toggle animate.
  await record();
  await caret(page, `${root}/Career`).click();
  expect(Math.max(...await recorded())).toBeGreaterThan(0);
  await settled(page);
  // A refresh that inserts a file before every other file shifts all later items.
  await record();
  await page.evaluate(async parent => {
    const { mockFiles } = await import("/src/lib/api/mock-fixtures.ts");
    const files = mockFiles[parent];
    const first = files.find(entry => entry.kind !== "directory")!;
    mockFiles[parent] = [...files, { ...first, name: "!early.txt", path: `${parent}/!early.txt` }];
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    await windowTabsManager.getActiveExplorer()!.refresh();
  }, root);
  await expect(row(page, `${root}/!early.txt`)).toHaveCount(1);
  expect(await recorded()).toEqual(Array(30).fill(0));
  // A row-count change (the window grows by two rows).
  const R = Number(await page.locator(`${shown} .list-view`).getAttribute("data-rows"));
  await record();
  await page.setViewportSize({ width: 720, height: 490 });
  await expect(page.locator(`${shown} .list-view`)).toHaveAttribute("data-rows", String(R + 2));
  expect(await recorded()).toEqual(Array(30).fill(0));
  // Navigation away and back.
  await record();
  await explorerCall(page, "return explorer.navigateTo(value)", `${root}/Archive`);
  await expect(row(page, `${root}/Archive/2019`)).toBeVisible();
  expect(await recorded()).toEqual(Array(30).fill(0));
  await record();
  await explorerCall(page, "return explorer.goBack()");
  await expect(row(page, `${root}/Career`)).toBeVisible();
  expect(await recorded()).toEqual(Array(30).fill(0));
});

test("interrupted toggles of cards leave no ghost, stuck style or hidden entry", async ({ page }) => {
  const R = await open(page);
  const folders = ["Career", "Archive", "Personal", "Inbox", "Codex"].map(name => `${root}/${name}`);
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 30; i++) {
    const path = folders[Math.floor(random() * folders.length)];
    await page.evaluate(([selector, target]) => (document.querySelector(`${selector} .entry-item[data-path="${target}"] .peek-caret`) as HTMLElement).click(), [shown, path] as const);
    await page.waitForTimeout(Math.floor(random() * 120));
  }
  await settled(page);
  const report = await page.evaluate(([selector, rows]) => {
    const pane = document.querySelector(selector)!;
    const port = pane.querySelector<HTMLElement>(".list-scroller")!.getBoundingClientRect();
    const slots = [...pane.querySelectorAll<HTMLElement>(".list-slot")];
    const problems: string[] = [];
    const columns = new Map<number, HTMLElement[]>();
    for (const el of slots) {
      if (el.classList.contains("covered") || getComputedStyle(el).visibility !== "visible") problems.push(`hidden ${el.dataset.motionKey}`);
      (columns.get(Number(el.dataset.column)) ?? columns.set(Number(el.dataset.column), []).get(Number(el.dataset.column))!).push(el);
      const scroll = el.querySelector<HTMLElement>("[data-card-scroll]");
      if (scroll && scroll.offsetHeight !== Number(getComputedStyle(scroll).getPropertyValue("--card-visible-rows")) * 30) problems.push(`card height ${el.dataset.motionKey}`);
    }
    for (const [column, list] of columns) {
      list.sort((a, b) => a.offsetTop - b.offsetTop);
      for (let i = 1; i < list.length; i++) if (list[i].offsetTop < list[i - 1].offsetTop + list[i - 1].offsetHeight) problems.push(`overlap in ${column}`);
      if (list.at(-1)!.offsetTop + list.at(-1)!.offsetHeight > rows * 30) problems.push(`overflow in ${column}`);
    }
    // Every visible plain row is what the pointer hits at its centre.
    for (const el of slots.filter(s => !s.querySelector("[data-card-scroll]"))) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < port.left || x > port.right) continue;
      if (!el.contains(document.elementFromPoint(x, y))) problems.push(`occluded ${el.dataset.motionKey}`);
    }
    return problems;
  }, [shown, R] as const);
  expect(report).toEqual([]);
  // The open set and the drawn cards agree.
  const expanded = (await explorerCall<string[]>(page, "return [...explorer.expandedPaths]")).sort();
  const drawn = await page.locator(`${shown} [data-card-scroll]`).evaluateAll(els => els.map(el => (el as HTMLElement).dataset.path!).sort());
  expect(drawn).toEqual(expanded.filter(path => path.split("/").length === 3));
});

test("three open 5,000-row cards keep the mounted entries bounded", async ({ page }) => {
  const R = await open(page, "/perf/huge-10000");
  for (const name of ["folder-00000", "folder-00016", "folder-00032"]) {
    await caret(page, `/perf/huge-10000/${name}`).click();
    await expect(card(page, `/perf/huge-10000/${name}`).locator(".entry-item").first()).toBeVisible();
  }
  await settled(page);
  const stats = await viewport(page).evaluate(el => ({ width: el.clientWidth, mounted: el.querySelectorAll(".entry-item").length }));
  const cap = Math.floor(0.7 * R);
  expect(stats.mounted).toBeLessThanOrEqual((Math.ceil(stats.width / 276) + 5) * R + 3 * (cap + 4));
  // Deep inside a card, scrolling keeps the window small.
  await card(page, "/perf/huge-10000/folder-00016").evaluate(el => { el.scrollTop = 2500 * 30; });
  await expect.poll(() => card(page, "/perf/huge-10000/folder-00016").evaluate(el => Math.min(...[...el.querySelectorAll<HTMLElement>(".list-row")].map(r => r.offsetTop)))).toBeGreaterThanOrEqual(2490 * 30);
  expect(await viewport(page).evaluate(el => el.querySelectorAll(".entry-item").length)).toBeLessThanOrEqual((Math.ceil(stats.width / 276) + 5) * R + 3 * (cap + 4));
});

const selectedPaths = (page: Page) => explorerCall<string[]>(page, "return [...explorer.selectedPaths]");

test("a Shift-range from a depth-0 item into a card's child rows selects exactly the visible range", async ({ page }) => {
  await open(page);
  await toggle(page, `${root}/Archive`);
  await row(page, `${root}/AI Draft Archive`).click();
  await row(page, `${root}/Archive/2021`).click({ modifiers: ["Shift"] });
  // Visible order: AI Draft Archive, Archive, then the card's rows 2019, 2020, 2021.
  expect((await selectedPaths(page)).sort()).toEqual([
    `${root}/AI Draft Archive`, `${root}/Archive`, `${root}/Archive/2019`, `${root}/Archive/2020`, `${root}/Archive/2021`,
  ].sort());
  // Rows beyond the range stay unselected.
  await expect(row(page, `${root}/Archive/2022`)).not.toHaveClass(/selected/);
  await expect(row(page, `${root}/Career`)).not.toHaveClass(/selected/);
});

test("with a card open Ctrl+A selects only the folder's own items and typeahead never lands on a peeked child", async ({ page }) => {
  await open(page);
  await toggle(page, `${root}/Career`);
  await row(page, `${root}/Inbox`).click();
  await page.keyboard.press("ControlOrMeta+A");
  const all = await selectedPaths(page);
  expect(all).toHaveLength(90);
  expect(all.filter(path => path.startsWith(`${root}/Career/`))).toEqual([]);
  await row(page, `${root}/Inbox`).click();
  // "offer" matches only Career/offer-letter.pdf, a peeked child: nothing moves.
  await page.keyboard.type("offer");
  expect(await selectedPaths(page)).toEqual([`${root}/Inbox`]);
  await expect(row(page, `${root}/Career/offer-letter.pdf`)).not.toHaveClass(/selected/);
  // A depth-0 name still matches once the type-ahead buffer (800ms) has cleared.
  await page.waitForTimeout(900);
  await page.keyboard.type("cod");
  await expect.poll(() => selectedPaths(page)).toEqual([`${root}/Codex`]);
});

test("peek groups are unboxed while nesting and resize controls remain visible", async ({ page }) => {
  await open(page);
  await toggle(page, `${root}/Career`);
  await toggle(page, `${root}/Career/Applications`);
  await expect(card(page, `${root}/Career`)).toBeVisible();
  await expect(row(page, `${root}/Career`)).toHaveAttribute("aria-expanded", "true");
  const chrome = await slot(page, `${root}/Career`).evaluate(element =>
    ["::before", "::after"].map(pseudo => getComputedStyle(element, pseudo).content));
  expect(chrome).toEqual(["none", "none"]);
  await expect(slot(page, `${root}/Career`).locator(".list-guide").first()).toBeVisible();
  await expect(slot(page, `${root}/Career`).getByRole("separator")).toBeVisible();
  await page.screenshot({ path: "screenshots/fix/bounding/unboxed-list-peek.png" });
});
