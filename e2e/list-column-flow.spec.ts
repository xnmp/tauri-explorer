import { test, expect, type Page } from "./fixtures";
import { runPaletteCommand, pressShortcut } from "./helpers";
import { startFrameSampler, stopFrameSampler } from "./frame-sampler";

const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.text().includes('derived_inert')) errors.push(message.text()); });
});
test.afterEach(async ({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });

const shown = ".pane-tree:not(.retained)";
const viewport = (page: Page) => page.locator(`${shown} .list-scroller`);
const entries = (page: Page) => page.locator(`${shown} .list-item`);
async function open(page: Page, count = 10000) {
  await page.goto(`/?path=/perf/huge-${count}&viewMode=list`);
  await expect(entries(page).first()).toBeVisible();
  await expect.poll(() => page.locator(`${shown} .list-view`).getAttribute("data-rows")).not.toBe("4");
}
async function focusedIndex(page: Page) {
  return page.evaluate(() => Number((document.activeElement as HTMLElement)?.dataset.index ?? -1));
}

test("column-major placement, bounded 10,000-entry window, and first/middle/final content", async ({ page }) => {
  await open(page);
  const R = Number(await page.locator(".list-view").getAttribute("data-rows"));
  const positions = await entries(page).evaluateAll(els => els.map(el => {
    const slot = el.parentElement!;
    return [Number((el as HTMLElement).dataset.index), Number(slot.dataset.column), slot.offsetTop, slot.offsetLeft];
  }));
  for (const [index,column,top,left] of positions) expect([column,top,left]).toEqual([Math.floor(index/R),index%R*30,Math.floor(index/R)*276]);
  const assertBound = async () => {
    const stats = await viewport(page).evaluate(el => ({ width: el.clientWidth, mounted: el.querySelectorAll(".list-item").length, left: el.scrollLeft, top: el.scrollTop }));
    expect(stats.mounted).toBeLessThanOrEqual((Math.ceil(stats.width/276)+5)*R);
    expect(stats.top).toBe(0);
  };
  await assertBound();
  await viewport(page).evaluate(el => { el.scrollLeft = 5000/Number(el.closest('.list-view')!.getAttribute('data-rows'))*276; });
  await expect(entries(page).first()).not.toHaveAttribute("data-index", "0");
  await expect.poll(async () => {
    const indices = await entries(page).evaluateAll(els => els.map(e => Number((e as HTMLElement).dataset.index)));
    return indices[0] <= 5000 && indices.at(-1)! >= 5000;
  }).toBe(true);
  await assertBound();
  await viewport(page).evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await expect(entries(page).last()).toHaveAttribute("data-index", "9999");
  await assertBound();
  await viewport(page).evaluate(el => { el.scrollLeft = 0; });
  await expect(entries(page).first()).toHaveAttribute("data-index", "0");
  // Folder Peek is on, so List rows form a tree (#1240): levels and expanded
  // state are not allowed on listbox options.
  await expect(viewport(page)).toHaveAttribute("role", "tree");
  await expect(entries(page).first()).toHaveAttribute("role", "treeitem");
  await expect(entries(page).first()).toHaveAttribute("aria-posinset", "1");
  await expect(entries(page).first()).toHaveAttribute("aria-setsize", "10000");
});

test("wheel maps vertical input once, normalizes units, and leaves horizontal gestures and Ctrl to the browser", async ({ page }) => {
  await open(page);
  const wheel = async (x: number,y: number,mode = 0,ctrl = false) => viewport(page).evaluate((el,args) => {
    el.scrollLeft = 1000;
    const event = new WheelEvent("wheel", { deltaX: args.x, deltaY: args.y, deltaMode: args.mode, ctrlKey: args.ctrl, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return { left: el.scrollLeft, top: el.scrollTop, prevented: event.defaultPrevented };
  },{x,y,mode,ctrl});
  expect(await wheel(0,100)).toEqual({left:1100,top:0,prevented:true});
  expect(await wheel(80,20)).toEqual({left:1000,top:0,prevented:false}); // native horizontal scrolling
  expect(await wheel(10,-90)).toEqual({left:910,top:0,prevented:true});
  expect(await wheel(0,2,1)).toEqual({left:1060,top:0,prevented:true});
  expect(await wheel(0,100,0,true)).toEqual({left:1000,top:0,prevented:false});
  const before = await entries(page).first().getAttribute("data-path");
  await viewport(page).hover();
  await page.mouse.wheel(0,4000);
  await expect(entries(page).first()).not.toHaveAttribute("data-path",before!);
  expect(await viewport(page).evaluate(el => el.scrollTop)).toBe(0);
});

test("fractional wheel deltas scroll symmetrically in both directions", async ({ page }) => {
  await open(page);
  const run = (delta: number, count: number) => viewport(page).evaluate((el, args) => {
    el.scrollLeft = 1000;
    for (let i = 0; i < args.count; i++) el.dispatchEvent(new WheelEvent("wheel", { deltaY: args.delta, bubbles: true, cancelable: true }));
    return el.scrollLeft - 1000;
  }, { delta, count });
  for (const d of [0.4, 0.7, 1.5]) {
    const down = await run(d, 20);
    const up = await run(-d, 20);
    expect(Math.abs(down - 20 * d)).toBeLessThanOrEqual(1.01);
    expect(up).toBe(-down);
  }
});

test("arrows, boundaries, pages, Home/End and modifiers reveal and focus actual entries", async ({ page }) => {
  await open(page, 100);
  const R = Number(await page.locator(".list-view").getAttribute("data-rows"));
  await entries(page).first().click();
  for (const [key,index] of [["ArrowUp",0],["ArrowDown",1],["ArrowRight",R+1],["ArrowLeft",1],["End",99],["ArrowRight",99],["ArrowDown",99],["Home",0]] as const) {
    await page.keyboard.press(key);
    await expect.poll(() => focusedIndex(page)).toBe(index);
  }
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator('.list-item.selected')).toHaveCount(3);
  await page.keyboard.press("Control+ArrowDown");
  await expect.poll(() => focusedIndex(page)).toBe(3);
  await expect(page.locator(".list-item.selected")).toHaveCount(3);
  const width = await viewport(page).evaluate(el => el.clientWidth - 16);
  const pageColumns = Math.max(1,Math.floor((width+16)/276));
  await page.keyboard.press("PageDown");
  await expect.poll(() => focusedIndex(page)).toBe(pageColumns*R+3);
  await page.keyboard.press("PageUp");
  await expect.poll(() => focusedIndex(page)).toBe(3);
  await page.keyboard.press("Control+End");
  await expect.poll(() => focusedIndex(page)).toBe(99);
  expect(await viewport(page).evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.press("Control+Home");
  await expect.poll(() => focusedIndex(page)).toBe(0);
  expect(await viewport(page).evaluate(el => el.scrollLeft)).toBe(0);
});

test("endpoint keys select, recompute ranges and re-reveal an unchanged cursor", async ({ page }) => {
  await open(page);
  await entries(page).first().click();
  await viewport(page).hover(); await page.mouse.wheel(0,20000);
  await expect(page.locator('.list-item[data-index="0"]')).toHaveCount(0);
  await page.keyboard.press('Home');
  await expect.poll(() => focusedIndex(page)).toBe(0);
  expect(await viewport(page).evaluate(el => el.scrollLeft)).toBe(0);
  await page.keyboard.press('Control+a');
  await expect.poll(() => page.locator('.list-item.selected').count()).toBeGreaterThan(1);
  await page.keyboard.press('Control+Home');
  await expect(page.locator('.list-item.selected')).toHaveCount(1);
  await entries(page).nth(2).click();
  await page.keyboard.press('Control+ArrowUp'); await page.keyboard.press('Control+ArrowUp');
  await expect.poll(() => focusedIndex(page)).toBe(0);
  await page.keyboard.press('Shift+Home');
  await expect(page.locator('.list-item.selected')).toHaveCount(3);
  await page.keyboard.press('End');
  await expect.poll(() => focusedIndex(page)).toBe(9999);
  await viewport(page).hover(); await page.mouse.wheel(0,-1000000);
  await expect(page.locator('.list-item[data-index="9999"]')).toHaveCount(0);
  await page.keyboard.press('End');
  await expect.poll(() => focusedIndex(page)).toBe(9999);
  await expect(page.locator('.list-item[data-index="9999"]')).toBeInViewport();
});

test("typeahead and Tab reentry reveal a distant unmounted entry", async ({ page }) => {
  await open(page);
  await entries(page).first().click();
  await page.keyboard.type("file-09999",{delay:20});
  await expect(page.locator('.list-item.selected')).toHaveAttribute("data-path", /\/file-09999\.md$/);
  const targetIndex = await focusedIndex(page);
  expect(targetIndex).toBeGreaterThan(1000);
  await viewport(page).evaluate(el => { el.dispatchEvent(new WheelEvent("wheel",{deltaY:-1000000,bubbles:true,cancelable:true})); });
  await expect(page.locator('.list-item[data-path$="/file-09999.md"]')).toHaveCount(0);
  await viewport(page).focus();
  await expect.poll(() => focusedIndex(page)).toBe(targetIndex);
});

for (const zoom of [100,130]) test(`every painted resize frame follows actual scrollport height at ${zoom}%`, async ({ page }) => {
  await page.addInitScript(zoom => localStorage.setItem("explorer-settings",JSON.stringify({zoomLevel:zoom})),zoom);
  await open(page);
  await viewport(page).evaluate(el => { new ResizeObserver(([entry]) => { el.dataset.actualHeight = String(entry.contentRect.height); }).observe(el); });
  await expect(viewport(page)).toHaveAttribute('data-actual-height', /./);
  await startFrameSampler(page, () => {
    const scroll = document.querySelector<HTMLElement>('.pane-tree:not(.retained) .list-scroller')!;
    const R = Math.max(4,Math.floor(Number(scroll.dataset.actualHeight)/30));
    return { R, actual: Number(scroll.closest('.list-view')!.getAttribute('data-rows')), positions: [...scroll.querySelectorAll<HTMLElement>('.list-item')].map(el => [Number(el.dataset.index), el.parentElement!.offsetTop, el.parentElement!.offsetLeft]) };
  });
  for (const height of [500,850,600]) await page.setViewportSize({width:1100,height});
  const frames = await stopFrameSampler<{R:number;actual:number;positions:number[][]}>(page);
  expect(frames.length).toBeGreaterThan(5);
  for (const frame of frames) {
    expect(frame.actual).toBe(frame.R);
    for (const [index,top,left] of frame.positions) expect([top,left]).toEqual([index%frame.R*30,Math.floor(index/frame.R)*276]);
  }
});

test("short scrollport keeps four reachable slots without changing pane minima", async ({ page }) => {
  await open(page);
  await viewport(page).evaluate(el => { el.style.flex = 'none'; el.style.height = '75px'; });
  await expect(page.locator('.list-view')).toHaveAttribute('data-rows','4');
  await expect(viewport(page)).toHaveCSS('overflow-y','auto');
  await entries(page).first().click();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedIndex(page)).toBe(3);
  expect(await viewport(page).evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await viewport(page).evaluate(el => { el.style.removeProperty('flex'); el.style.removeProperty('height'); });
  await expect.poll(async () => Number(await page.locator('.list-view').getAttribute('data-rows'))).toBeGreaterThan(4);
  await expect(viewport(page)).toHaveCSS('overflow-y','hidden');
  await expect.poll(() => viewport(page).evaluate(el => el.scrollTop)).toBe(0);
});

test("creation reveals slot zero, keeps editors mounted while scrolling, and handles empty folders", async ({ page }) => {
  await open(page);
  await viewport(page).evaluate(el => { el.scrollLeft = 50000; });
  await runPaletteCommand(page,'New Folder');
  const input = page.locator('.new-folder-input');
  await expect(input).toBeFocused();
  expect(await viewport(page).evaluate(el => el.scrollLeft)).toBe(0);
  await input.fill('column creation');
  await viewport(page).evaluate(el => { el.scrollLeft = 50000; });
  await expect(input).toHaveValue('column creation');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await page.keyboard.press('Home');
  await expect(page.locator('.list-item[data-path$="/column creation"]')).toBeVisible();
  await page.goto('/?path=/home/user/Archive&viewMode=list');
  await expect(page.locator('.empty-state')).toBeVisible();
  await runPaletteCommand(page,'New Folder');
  await expect(input).toBeFocused();
  await expect(input.locator('..')).toHaveCSS('height','30px');
  await input.fill('from empty'); await input.press('Enter');
  await expect(page.locator('.list-item[data-path$="/from empty"]')).toBeVisible();
});

test("rename survives horizontal virtualization and retains its value", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const { mockFiles } = await import('/src/lib/api/mock-fixtures.ts');
    const { windowTabsManager } = await import('/src/lib/state/window-tabs.svelte.ts');
    const path = '/home/list-renaming';
    mockFiles[path] = Array.from({length:1000}, (_,i) => ({name:`item-${String(i).padStart(4,'0')}.md`,path:`${path}/item-${String(i).padStart(4,'0')}.md`,kind:'file',size:1,modified:''}));
    await windowTabsManager.getActiveExplorer().navigateTo(path);
  });
  await expect(entries(page).first()).toHaveAttribute('data-path','/home/list-renaming/item-0000.md');
  await entries(page).first().click(); await page.keyboard.press('F2');
  const editor = page.locator('.rename-input');
  await editor.fill('renamed column folder');
  await viewport(page).evaluate(el => { el.scrollLeft = 50000; });
  await expect(editor).toHaveValue('renamed column folder');
  await editor.press('Enter');
  await expect(editor).toHaveCount(0);
  await page.keyboard.press('Home');
  await page.keyboard.type('renamed column folder');
  await expect(page.locator('.list-item.selected')).toHaveAttribute('data-path',/\/renamed column folder$/);
});

test("retained List tabs preserve horizontal offset and row identity", async ({ page }) => {
  await open(page);
  await viewport(page).evaluate(el => { el.scrollLeft = 5000; });
  await expect(entries(page).first()).not.toHaveAttribute('data-index','0');
  const path = await entries(page).nth(4).getAttribute('data-path');
  await page.locator(`.list-item[data-path="${path}"]`).evaluate(el => { (el as any).__listRetained = true; });
  const offset = await viewport(page).evaluate(el => el.scrollLeft);
  await page.keyboard.press('Control+t');
  await expect(page.locator('.tab')).toHaveCount(2);
  await page.keyboard.press('Control+Shift+Tab');
  await expect(page.locator(`${shown} .list-item[data-path="${path}"]`)).toBeVisible();
  expect(await viewport(page).evaluate(el => el.scrollLeft)).toBe(offset);
  expect(await page.locator(`${shown} .list-item[data-path="${path}"]`).evaluate(el => (el as any).__listRetained)).toBe(true);
  await expect(page.locator('.pane-tree.retained')).toHaveAttribute('inert','');
});

test("sideways marquee uses global indices and refreshes under a stationary pointer", async ({ page }) => {
  await open(page);
  await viewport(page).evaluate(el => { el.scrollLeft = 5000; });
  await expect(entries(page).first()).not.toHaveAttribute('data-index','0');
  const rect = await viewport(page).boundingBox();
  const R = Number(await page.locator('.list-view').getAttribute('data-rows'));
  // Start in the unoccupied tail below the last complete row.
  const start = { x:rect!.x+30,y:rect!.y+6+R*30+1 };
  const end = { x:rect!.x+210,y:rect!.y+10 };
  await page.mouse.move(start.x,start.y); await page.mouse.down();
  await page.mouse.move(end.x,end.y,{steps:4});
  const expected = () => page.evaluate(() => {
    const band = document.querySelector('.marquee-rect')!.getBoundingClientRect();
    const scroll = document.querySelector('.list-scroller')!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('.list-item')].filter(el => {
      const r = el.getBoundingClientRect();
      return Math.min(r.right,scroll.right)>Math.max(r.left,scroll.left) && r.right>band.left && r.left<band.right && r.bottom>band.top && r.top<band.bottom;
    }).map(el => el.dataset.path).sort();
  });
  const selected = () => page.locator('.list-item.selected').evaluateAll(els => els.map(el => (el as HTMLElement).dataset.path).sort());
  // Pointer moves are coalesced to a frame; wait for the band before sampling
  // its expected intersections, rather than accepting two premature [] values.
  await expect.poll(async () => (await selected()).length).toBeGreaterThan(0);
  await expect.poll(selected).toEqual(await expected());
  const before = await selected();
  expect(before.length).toBeGreaterThan(0);
  await viewport(page).evaluate(el => { el.scrollLeft += 276*8; });
  await expect.poll(selected).not.toEqual(before);
  await expect.poll(selected).toEqual(await expected());
  await page.mouse.up();
});

test("context targets entries and gaps after sideways scrolling; a drop reaches the visible folder", async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const { mockFiles } = await import('/src/lib/api/mock-fixtures.ts');
    const { windowTabsManager } = await import('/src/lib/state/window-tabs.svelte.ts');
    const path = '/home/list-drop';
    mockFiles[path] = Array.from({length:1000},(_,i) => ({name:`folder-${String(i).padStart(4,'0')}`,path:`${path}/folder-${String(i).padStart(4,'0')}`,kind:'directory',size:0,modified:''}));
    for (const entry of mockFiles[path]) mockFiles[entry.path] = [];
    await windowTabsManager.getActiveExplorer().navigateTo(path);
  });
  await expect(entries(page).first()).toHaveAttribute('data-path','/home/list-drop/folder-0000');
  await viewport(page).hover();
  await page.mouse.wheel(0,3000);
  await expect(entries(page).first()).not.toHaveAttribute('data-index','0');
  const target = await viewport(page).evaluate(el => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>('.list-item.directory')].find(item => {
      const r = item.getBoundingClientRect(); return r.left>=box.left && r.right<=box.right;
    })!.dataset.path!;
  });
  const item = page.locator(`.list-item[data-path="${target}"]`);
  await item.click({button:'right'});
  await expect(item).toHaveClass(/selected/);
  await expect(page.getByRole('menuitem',{name:/^Rename/})).toBeVisible();
  await page.keyboard.press('Escape');
  const gap = await item.boundingBox();
  await page.mouse.click(gap!.x+gap!.width+5,gap!.y+12,{button:'right'});
  await expect(page.getByRole('menuitem',{name:/^New folder/})).toBeVisible();
  await expect(page.locator('.list-item.selected')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Use the actual shared DOM drop route, with an existing mutable source fixture.
  await item.evaluate(async element => {
    const { createHtml5FileDrag } = await import('/src/lib/state/html5-file-drag.svelte.ts');
    const source = createHtml5FileDrag();
    const data = new DataTransfer();
    source.start(new DragEvent('dragstart',{dataTransfer:data}),{path:'/home/user/notes.md',name:'notes.md',kind:'file'});
    for (const type of ['dragover','drop']) element.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:data}));
  });
  await expect(page.locator('.toast').filter({hasText:/Moved/})).toHaveCount(1);
  await item.dblclick();
  await expect(page.locator(`.content[data-current-path="${target}"] .list-item[data-path$="/notes.md"]`)).toBeVisible();
});


test("narrow columns retain leading-edge alignment through repeated reveals", async ({ page }) => {
  await open(page);
  await viewport(page).evaluate(el => { el.style.flex='none'; el.style.width='200px'; });
  await entries(page).first().click();
  for (let i=1;i<=3;i++) {
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focusedIndex(page)).toBe(i);
    expect(await viewport(page).evaluate(el => el.scrollLeft)).toBe(0);
  }
});

test("hidden-tab resize uses live rows on activation and preserves manual scroll intent", async ({ page }) => {
  await open(page);
  await entries(page).first().click();
  await viewport(page).hover(); await page.mouse.wheel(0,6000);
  await expect(entries(page).first()).not.toHaveAttribute('data-index','0');
  const oldRows = Number(await page.locator('.list-view').getAttribute('data-rows'));
  await page.keyboard.press('Control+t');
  await expect(page.locator('.tab')).toHaveCount(2);
  await page.setViewportSize({width:1280,height:500});
  await page.keyboard.press('Control+Shift+Tab');
  await expect.poll(() => page.locator(`${shown} .list-view`).getAttribute('data-rows').then(Number)).not.toBe(oldRows);
  expect(await viewport(page).evaluate(el => el.scrollLeft)).toBeGreaterThan(3000);
  await expect(entries(page).first()).not.toHaveAttribute('data-index','0');
});

test("same-count rename reorders a mounted List without a stale navigation snapshot", async ({ page }) => {
  await open(page,100);
  await page.evaluate(async () => {
    const { mockFiles } = await import('/src/lib/api/mock-fixtures.ts');
    const { windowTabsManager } = await import('/src/lib/state/window-tabs.svelte.ts');
    const path = '/home/list-reordering';
    mockFiles[path] = Array.from({length:100}, (_,i) => ({name:`item-${String(i).padStart(4,'0')}.md`,path:`${path}/item-${String(i).padStart(4,'0')}.md`,kind:'file',size:1,modified:''}));
    await windowTabsManager.getActiveExplorer().navigateTo(path);
  });
  await expect(entries(page).first()).toHaveAttribute('data-path','/home/list-reordering/item-0000.md');
  await viewport(page).evaluate(el => { (el as any).__sameList = true; });
  await entries(page).nth(2).click();
  await page.evaluate(async () => {
    const { mockFiles } = await import('/src/lib/api/mock-fixtures.ts');
    const { windowTabsManager } = await import('/src/lib/state/window-tabs.svelte.ts');
    const path = '/home/list-reordering';
    mockFiles[path] = mockFiles[path].map((entry,index) => index === 0 ? {...entry,name:'zzz.md',path:`${path}/zzz.md`} : entry);
    await windowTabsManager.getActiveExplorer().refresh({silent:true});
  });
  await expect(entries(page).first()).toHaveAttribute('data-path','/home/list-reordering/item-0001.md');
  await expect(page.locator('.list-item.selected')).toHaveAttribute('data-index','1');
  expect(await viewport(page).evaluate(el => (el as any).__sameList)).toBe(true);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedIndex(page)).toBe(2);
  await expect(page.locator('.list-item.selected')).toHaveAttribute('data-path','/home/list-reordering/item-0003.md');
});

for (const dock of ['bottom','top','right']) test(`preview ${dock} dock and fullscreen exit retain a current column layout`, async ({ page }) => {
  await page.addInitScript(dock => localStorage.setItem('explorer-settings',JSON.stringify({previewPanePosition:dock,showPreviewPane:true})),dock);
  await page.goto('/?path=/home/tiles-fullscreen&viewMode=list');
  await expect(entries(page).first()).toBeVisible();
  await page.locator('.list-item[data-path$="/shot-05.png"]').click();
  await expect(page.locator('.preview-image')).toHaveAttribute('alt','shot-05.png');
  const layout = () => viewport(page).evaluate(el => ({R:el.closest('.list-view')!.getAttribute('data-rows'),width:el.clientWidth,left:el.scrollLeft,top:el.scrollTop}));
  const before = await layout();
  await page.locator('.preview-image').click();
  await expect(page.locator('.preview-pane')).toHaveClass(/fullscreen/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.preview-pane')).not.toHaveClass(/fullscreen/);
  expect(await layout()).toEqual(before);
  await pressShortcut(page,' ');
  await expect(page.locator('.preview-pane')).toBeHidden();
  await pressShortcut(page,' ');
  await expect(page.locator('.preview-pane')).toBeVisible();
  await expect.poll(layout).toEqual(before);
});

for (const previous of ['details','tiles']) test(`cold List import retires ${previous} callbacks and reveals the new cursor`, async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/src/lib/components/ListColumnsView.svelte*',async route => { requested = true; await gate; await route.continue(); });
  await page.goto(`/?path=/perf/huge-1000&viewMode=${previous}`);
  await expect(page.locator(`.${previous}-view .entry-item`).first()).toBeVisible();
  await page.evaluate(async () => {
    const { windowTabsManager } = await import('/src/lib/state/window-tabs.svelte.ts');
    windowTabsManager.getActiveExplorer().setViewMode('list');
  });
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(async () => {
    const { windowTabsManager } = await import('/src/lib/state/window-tabs.svelte.ts');
    const explorer = windowTabsManager.getActiveExplorer();
    await explorer.navigateTo('/perf/huge-10000');
    explorer.selectEntry(explorer.displayEntries.at(-1)!,{});
  });
  release();
  await expect(viewport(page)).toBeVisible();
  await viewport(page).focus();
  await expect.poll(() => focusedIndex(page)).toBe(9999);
  await expect(page.locator('.list-item[data-index="9999"]')).toBeInViewport();
});
