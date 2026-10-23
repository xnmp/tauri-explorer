import { test, expect, type Page, type TestInfo } from "./fixtures";

// List peek-in-place (#1365): opening a folder and "+N more" never move its
// header. A click opens the compact card in place (shrunk near the column
// bottom); "+N more" spills the rows below the header into the column flow,
// capped at the rest of the column plus the next one, ending in "+N more".
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
const card = (page: Page, path: string) => slot(page, path).locator("[data-card-scroll]");
const moreSlot = (page: Page, path: string) => page.locator(`${shown} .list-slot[data-motion-key="more:${path}"]`);
const scrollLeft = (page: Page) => viewport(page).evaluate(el => el.scrollLeft);
const place = async (page: Page, path: string) => {
  const element = slot(page, path);
  return [Number(await element.getAttribute("data-column")), await element.evaluate(el => (el as HTMLElement).offsetTop / 30)];
};
const explorerCall = <T>(page: Page, body: string, arg?: unknown) => page.evaluate(async ([source, value]) => {
  const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
  return new Function("explorer", "value", source)(windowTabsManager.getActiveExplorer()!, value);
}, [body, arg] as const) as Promise<T>;

/** Waits until no List motion is running, nor starts within its length. */
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

const SIZE = 80;
/**
 * A directory whose folder `Big` sits on row `before` of column 0 (List lists
 * folders first). Big holds 30 folders, then 50 files; every folder is empty.
 */
async function scene(page: Page, before: number, width = 900): Promise<{ R: number; base: string; big: string }> {
  await page.setViewportSize({ width, height: 430 });
  await page.goto("/?path=/folder-peek-list&viewMode=list");
  await expect(page.locator(`${shown} .list-item`).first()).toBeVisible();
  await expect.poll(() => page.locator(`${shown} .list-view`).getAttribute("data-rows")).not.toBe("4");
  const R = Number(await page.locator(`${shown} .list-view`).getAttribute("data-rows"));
  const base = `/list-in-place-${before}`, big = `${base}/Big`;
  await page.evaluate(([base, big, before, size]) => import("/src/lib/api/mock-fixtures.ts").then(({ mockFiles }) => {
    const entry = (path: string, kind: "file" | "directory") => ({ path, name: path.split("/").at(-1)!, kind, size: 1, modified: "" });
    const above = Array.from({ length: before }, (_, i) => entry(`${base}/A-${String(i).padStart(2, "0")}`, "directory"));
    mockFiles[base] = [...above, entry(big, "directory"), entry(`${base}/after-1.txt`, "file"), entry(`${base}/after-2.txt`, "file")];
    for (const folder of above) mockFiles[folder.path] = [];
    const folders = Array.from({ length: 30 }, (_, i) => entry(`${big}/d-${String(i).padStart(2, "0")}`, "directory"));
    for (const folder of folders) mockFiles[folder.path] = [];
    mockFiles[big] = [...folders, ...Array.from({ length: size - 30 }, (_, i) => entry(`${big}/f-${String(i).padStart(2, "0")}.txt`, "file"))];
  }), [base, big, before, SIZE] as const);
  await explorerCall(page, "return explorer.navigateTo(value)", base);
  await expect(row(page, big)).toBeVisible();
  return { R, base, big };
}

/** Big's n-th child, in List order (30 folders, then files). */
const child = (big: string, n: number) => n < 30 ? `${big}/d-${String(n).padStart(2, "0")}` : `${big}/f-${String(n - 30).padStart(2, "0")}.txt`;

/** Opens or closes Big with a plain click on its caret and waits for its peek to settle. */
async function click(page: Page, path: string) {
  const open = await row(page, path).getAttribute("aria-expanded") === "true";
  await row(page, path).locator(":scope > .peek-caret").click();
  await expect(row(page, path)).toHaveAttribute("aria-expanded", String(!open));
  await expect.poll(() => explorerCall<string>(page, "return explorer.peekStatus(value) ?? 'none'", path)).not.toBe("loading");
  await settled(page);
}
/** The compact card's "+N more", inside the folder's header treeitem. */
const showMore = (page: Page) => page.locator(`${shown} .entry-item`).getByRole("button", { name: "Show more Big items" });
const shrink = (page: Page, big: string) => row(page, big).getByRole("button", { name: "Shrink Big to a card" });
const capture = (info: TestInfo, page: Page, path: string) => info.project.name === "chromium" ? page.screenshot({ path, animations: "disabled" }) : Promise.resolve();

test("a click opens the compact card in place, even after the folder showed every row", async ({ page }, info) => {
  const { R, big } = await scene(page, 4);
  const closed = await row(page, big).boundingBox();
  const scroll = await scrollLeft(page);
  await click(page, big);
  expect(await row(page, big).boundingBox()).toEqual(closed);
  expect(await scrollLeft(page)).toBe(scroll);
  await expect(card(page, big)).toHaveCount(1);
  expect(await place(page, big)).toEqual([0, 4]);
  await capture(info, page, "screenshots/feat/list-peek-in-place/compact-in-place.png");
  // Spill, then show every row, then close: the stage is forgotten.
  await showMore(page).click();
  await settled(page);
  await moreSlot(page, big).getByRole("button", { name: "Show all Big items" }).click();
  await settled(page);
  expect(await explorerCall<boolean>(page, "return explorer.listFullFlowPaths.has(value)", big)).toBe(true);
  await click(page, big);
  await viewport(page).evaluate(el => { el.scrollLeft = 0; });
  await settled(page);
  await click(page, big);
  // A plain click gives the compact card again: header unmoved, no sideways pan.
  expect(await row(page, big).boundingBox()).toEqual(closed);
  expect(await scrollLeft(page)).toBe(0);
  await expect(card(page, big)).toHaveCount(1);
  await expect(shrink(page, big)).toHaveCount(0);
  await expect(moreSlot(page, big)).toHaveCount(0);
  expect(await card(page, big).evaluate(el => el.clientHeight)).toBe(Math.min(6, R - 5) * 30);
});

test("+N more spills the rows in place: the rest of the column, the next column, then +N more", async ({ page }, info) => {
  const { R, big } = await scene(page, 4);
  await click(page, big);
  const header = await row(page, big).boundingBox();
  const scroll = await scrollLeft(page);
  await showMore(page).click();
  await settled(page);
  await expect(card(page, big)).toHaveCount(0);
  expect(await row(page, big).boundingBox()).toEqual(header);
  expect(await scrollLeft(page)).toBe(scroll);
  await expect(row(page, big)).toBeFocused();
  // Rows 5..R-1 of column 0, then rows 0..R-2 of column 1, then "+N more".
  const below = R - 5, shown = below + R - 1;
  expect(await place(page, child(big, 0))).toEqual([0, 5]);
  expect(await place(page, child(big, below - 1))).toEqual([0, R - 1]);
  expect(await place(page, child(big, below))).toEqual([1, 0]);
  expect(await place(page, child(big, shown - 1))).toEqual([1, R - 2]);
  await expect(row(page, child(big, shown))).toHaveCount(0);
  const more = moreSlot(page, big);
  expect([Number(await more.getAttribute("data-column")), await more.evaluate(el => (el as HTMLElement).offsetTop / 30)]).toEqual([1, R - 1]);
  await expect(more.getByRole("button", { name: "Show all Big items" })).toHaveText(`+${SIZE - shown} more`);
  // Later items start the column after the spill.
  expect(await place(page, `${big.slice(0, big.lastIndexOf("/"))}/after-1.txt`)).toEqual([2, 0]);
  await capture(info, page, "screenshots/feat/list-peek-in-place/spill.png");
  await capture(info, page, "evidence/issue-1365-spill.png");
  // "+N more" on the last slot shows every row; its row takes the slot and the keyboard.
  await more.getByRole("button").click();
  await settled(page);
  await expect(more).toHaveCount(0);
  expect(await row(page, big).boundingBox()).toEqual(header);
  await expect(row(page, child(big, shown))).toBeFocused();
  expect(await place(page, child(big, shown))).toEqual([1, R - 1]);
});

test("near the column bottom a folder opens shrunk in place with three slots left, else starts the next column", async ({ page }) => {
  for (const [left, expected] of [[3, "in place"], [2, "next column"]] as const) {
    const { R, big } = await scene(page, 10 - left);
    expect(R).toBe(10);
    await click(page, big);
    if (expected === "in place") {
      expect(await place(page, big)).toEqual([0, R - left]);
      expect(await card(page, big).evaluate(el => el.clientHeight)).toBe((left - 1) * 30);
    } else expect(await place(page, big)).toEqual([1, 0]);
    // Spilling never moves it from there.
    const at = await place(page, big), header = await row(page, big).boundingBox();
    await showMore(page).click();
    await settled(page);
    expect(await place(page, big)).toEqual(at);
    expect(await row(page, big).boundingBox()).toEqual(header);
  }
});

test("a folder on the last row starts the next column and spills through it and the one after", async ({ page }, info) => {
  const { R, big } = await scene(page, 9, 1200);
  expect(R).toBe(10);
  expect(await place(page, big)).toEqual([0, R - 1]);
  await click(page, big);
  expect(await place(page, big)).toEqual([1, 0]);
  await showMore(page).click();
  await settled(page);
  expect(await place(page, big)).toEqual([1, 0]);
  expect(await place(page, child(big, 0))).toEqual([1, 1]);
  expect(await place(page, child(big, 2 * R - 3))).toEqual([2, R - 2]);
  await expect(moreSlot(page, big).getByRole("button")).toHaveText(`+${SIZE - (2 * R - 2)} more`);
  await capture(info, page, "screenshots/feat/list-peek-in-place/last-row-spill.png");
});

test("Less returns spill and full flow to the compact card; closing forgets the stage", async ({ page }) => {
  const { big } = await scene(page, 4);
  await click(page, big);
  const compact = await card(page, big).evaluate(el => el.clientHeight);
  const header = await row(page, big).boundingBox();
  await showMore(page).click();
  await settled(page);
  await shrink(page, big).click();
  await settled(page);
  await expect(card(page, big)).toHaveCount(1);
  expect(await card(page, big).evaluate(el => el.clientHeight)).toBe(compact);
  await expect(row(page, big)).toBeFocused();
  await showMore(page).click();
  await settled(page);
  await moreSlot(page, big).getByRole("button").click();
  await settled(page);
  expect(await explorerCall<boolean>(page, "return explorer.listFullFlowPaths.has(value)", big)).toBe(true);
  await shrink(page, big).click();
  await settled(page);
  await expect(card(page, big)).toHaveCount(1);
  expect(await row(page, big).boundingBox()).toEqual(header);
  // Spilled, then closed and reopened: the compact card.
  await showMore(page).click();
  await settled(page);
  await click(page, big);
  await click(page, big);
  await expect(card(page, big)).toHaveCount(1);
  expect(await explorerCall<number>(page, "return explorer.listSpillPaths.size + explorer.listFullFlowPaths.size")).toBe(0);
});

test("keyboard, marquee and drops work across the spill's column break", async ({ page }) => {
  const { R, big } = await scene(page, 4);
  await click(page, big);
  await showMore(page).click();
  await settled(page);
  const below = R - 5;
  // Right from column 0 lands on the same row of column 1, and back.
  await row(page, child(big, below - 2)).click();
  await page.keyboard.press("ArrowRight");
  const across = child(big, below + R - 2);
  await expect(row(page, across)).toBeFocused();
  await expect(row(page, across)).toHaveClass(/selected/);
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, child(big, below - 2))).toBeFocused();
  // Down stops at the column's end, as for any column.
  await row(page, child(big, below - 1)).click();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, child(big, below - 1))).toBeFocused();
  // End reaches the entry after the spill, past the hidden rows.
  await page.keyboard.press("End");
  const end = `${big.slice(0, big.lastIndexOf("/"))}/after-2.txt`;
  await expect(row(page, end)).toBeFocused();
  await expect(row(page, end)).toHaveClass(/selected/);

  // A marquee from the empty strip under column 0 into column 1 selects the
  // spilled rows it crosses in both columns.
  const port = (await viewport(page).boundingBox())!;
  await page.mouse.click(port.x + 30, port.y + 6 + R * 30 + 1);
  await page.mouse.move(port.x + 30, port.y + 6 + R * 30 + 1);
  await page.mouse.down();
  await page.mouse.move(port.x + 276 + 60, port.y + 6 + (R - 4) * 30 + 10, { steps: 5 });
  const selected = () => page.locator(`${shown} .list-item.selected`).evaluateAll(els => els.map(el => (el as HTMLElement).dataset.path).sort());
  // Rows R-4..R-1 of both columns; column 1's last slot is "+N more", not an entry.
  const expected = [
    ...[4, 3, 2, 1].map(up => child(big, below - up)),
    ...[4, 3, 2].map(up => child(big, below + R - up)),
  ].sort();
  await expect.poll(selected).toEqual(expected);
  await page.mouse.up();

  // A drop on a folder row past the column break moves into that folder.
  const target = child(big, below + 3);
  expect(await place(page, target)).toEqual([1, 3]);
  await row(page, target).evaluate(async element => {
    const { createHtml5FileDrag } = await import("/src/lib/state/html5-file-drag.svelte.ts");
    const source = createHtml5FileDrag();
    const data = new DataTransfer();
    source.start(new DragEvent("dragstart", { dataTransfer: data }), { path: "/home/user/notes.md", name: "notes.md", kind: "file" });
    for (const type of ["dragover", "drop"]) element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await expect(page.locator(".toast").filter({ hasText: /Moved/ })).toHaveCount(1);
  await expect.poll(() => page.evaluate(async folder => {
    const { mockFiles } = await import("/src/lib/api/mock-fixtures.ts");
    return (mockFiles[folder] ?? []).map(entry => entry.name);
  }, target)).toEqual(["notes.md"]);
});
