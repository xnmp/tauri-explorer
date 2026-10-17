import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import * as client from "svelte/internal/client";
import * as flow from "$lib/domain/list-column-flow";
import * as cards from "$lib/domain/list-cards";
import { flatPeekEntries, flatPeekRows } from "$lib/domain/folder-peek-flat";
import { dropHover } from "$lib/state/drop-hover";
import { createRafCoalescer } from "$lib/domain/raf-coalesce";
import type { useListColumns } from "$lib/composables/use-list-columns.svelte";
import type { FileEntry } from "$lib/domain/file";
import type { PeekRow, PeekRows } from "$lib/domain/folder-peek";

// Run the production composable against Svelte's client runtime: Vitest's SSR
// transform drops effects, which would hide the scroll/resize wiring under test.
function compileClient(path: string): string {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  return compileModule(javascript, { generate: "client" }).js.code
    .replace("import * as $ from 'svelte/internal/client';", "")
    .replace(/import\s+[^;]+;/g, "")
    .replaceAll("export ", "");
}

const svelte = {
  flushSync: (fn?: () => void) => client.flush(fn),
  tick: client.tick, untrack: client.untrack, onDestroy: () => {},
  getAbortSignal: () => new AbortController().signal,
};
const create = new Function("$", "svelte", "flow", "cards", "dropHover", "createRafCoalescer",
  `const { flushSync, getAbortSignal, onDestroy, tick, untrack } = svelte;
   const { ${Object.keys(flow).join(", ")} } = flow;
   const { ${Object.keys(cards).join(", ")} } = cards;
   ${compileClient("../../src/lib/composables/use-list-columns.svelte.ts")}
   return useListColumns;`)(client, svelte, flow, cards, dropHover, createRafCoalescer) as typeof useListColumns;

const entries = (n: number): FileEntry[] => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, path: `/d/f${i}`, kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" }) as FileEntry);

/** `/d/open` expanded with `children` rows, then `after` plain siblings. */
function cardRows(children: number, after: number): PeekRows {
  const open = { name: "open", path: "/d/open", kind: "directory", size: 0, modified: "" } as FileEntry;
  const kids = Array.from({ length: children }, (_, i) => ({ name: `k${i}`, path: `/d/open/k${i}`, kind: "file", size: 1, modified: "" }) as FileEntry);
  const rows: PeekRow[] = [
    { kind: "entry", key: "entry:/d/open", entry: open, entryIndex: 0, expanded: true, depth: 0, parentPath: "/d" },
    ...kids.map((entry, i) => ({ kind: "entry" as const, key: `entry:${entry.path}`, entry, entryIndex: i + 1, expanded: false, depth: 1, parentPath: open.path })),
    ...entries(after).map((entry, i) => ({ kind: "entry" as const, key: `entry:${entry.path}`, entry, entryIndex: children + 1 + i, expanded: false, depth: 0, parentPath: "/d" })),
  ];
  return { rows, entryToRow: rows.map((_, i) => i), rowToEntry: rows.map((_, i) => i), groups: [{ path: open.path, depth: 0, startRow: 1, endRow: children + 1 }] };
}

function mount(items: readonly FileEntry[] | PeekRows, size: { width: number; height: number }) {
  const listeners = new Map<string, (event: unknown) => void>();
  let resize!: (entries: unknown[]) => void;
  vi.stubGlobal("ResizeObserver", class { constructor(cb: typeof resize) { resize = cb; } observe() {} disconnect() {} });
  vi.stubGlobal("getComputedStyle", () => ({ width: `${size.width}px` }));
  const element = {
    scrollLeft: 0, scrollTop: 0, scrollWidth: 10000, clientWidth: size.width, clientHeight: size.height, isConnected: true,
    getClientRects: () => [{}],
    addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
    querySelector: () => ({}),
  };
  let columns!: ReturnType<typeof useListColumns>;
  const dispose = client.effect_root(() => {
    const rows = "rows" in items ? items : flatPeekRows(flatPeekEntries("/d", items), false);
    columns = create({ getRows: () => rows, getPreferredRows: () => undefined, getPinnedPaths: () => [] });
    columns.attach(element as unknown as HTMLElement);
  });
  client.flush(() => resize([{ contentRect: { width: size.width, height: size.height } }]));
  return {
    columns, dispose,
    scrollTo(left: number) { element.scrollLeft = left; listeners.get("scroll")!({}); },
    wheel: (event: object) => listeners.get("wheel")!(event),
    element,
  };
}

describe("useListColumns cards", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reveals a card row by scrolling the card synchronously, so it is mounted for focus", () => {
    // 10 rows per column: the card shows 6 of its 40 rows (floor(0.7 * 10) = 7 cap, default 6).
    const mounted = mount(cardRows(40, 20), { width: 800, height: 300 });
    const { columns } = mounted;
    expect(columns.model.items[0].card?.visibleRows).toBe(6);
    expect(columns.containsEntry(30)).toBe(false);
    columns.revealEntry(30); // content offset 29
    expect(columns.cardScrollTop("/d/open")).toBe((29 - 5) * 30);
    expect(columns.containsEntry(30)).toBe(true);
    expect(columns.cardOffsets(columns.model.items[0].card!)).toContain(29);
    mounted.dispose();
  });

  it("previews a grip drag on its card only, hiding what it would cover, and forgets offsets of closed cards", () => {
    const rows = cardRows(40, 20);
    let current = rows;
    const listeners = new Map<string, (event: unknown) => void>();
    let resize!: (entries: unknown[]) => void;
    vi.stubGlobal("ResizeObserver", class { constructor(cb: typeof resize) { resize = cb; } observe() {} disconnect() {} });
    vi.stubGlobal("getComputedStyle", () => ({ width: "800px" }));
    const element = { scrollLeft: 0, scrollTop: 0, scrollWidth: 10000, clientWidth: 800, clientHeight: 300, isConnected: true,
      getClientRects: () => [{}], addEventListener: (n: string, fn: (e: unknown) => void) => listeners.set(n, fn), removeEventListener: () => {}, querySelector: () => ({}) };
    const source = client.state(0);
    let columns!: ReturnType<typeof useListColumns>;
    const dispose = client.effect_root(() => {
      columns = create({ getRows: () => { client.get(source); return current; }, getPreferredRows: () => undefined, getPinnedPaths: () => [] });
      columns.attach(element as unknown as HTMLElement);
    });
    client.flush(() => resize([{ contentRect: { width: 800, height: 300 } }]));
    // Card occupies rows 0..6 of column 0; plain siblings fill rows 7..9.
    columns.setPreview("/d/open", 7);
    client.flush();
    expect(columns.layout.byIndex[1]).toMatchObject({ column: 0, row: 7 });
    expect(columns.isCovered("entry:/d/f0")).toBe(true);
    expect(columns.isCovered("entry:/d/f1")).toBe(false);
    columns.setPreview("/d/open", null);
    client.flush();
    expect(columns.isCovered("entry:/d/f0")).toBe(false);
    columns.setCardScrollTop("/d/open", 90);
    // A preview whose card closes before its grip's cancel arrives is dropped.
    columns.setPreview("/d/open", 7);
    current = flatPeekRows(flatPeekEntries("/d", entries(5)), false);
    client.flush(() => client.set(source, 1));
    expect(columns.cardScrollTop("/d/open")).toBe(0);
    expect(columns.previewRows("/d/open")).toBeNull();
    current = rows;
    client.flush(() => client.set(source, 2));
    expect(columns.model.items[0].card?.visibleRows).toBe(6);
    expect(columns.previewRows("/d/open")).toBeNull();
    expect(columns.isCovered("entry:/d/f0")).toBe(false);
    dispose();
  });

  it("tells FileList after a card scroll changes the mounted rows, once per frame", async () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frame = cb; return 1; });
    const listeners = new Map<string, (event: unknown) => void>();
    let resize!: (entries: unknown[]) => void;
    vi.stubGlobal("ResizeObserver", class { constructor(cb: typeof resize) { resize = cb; } observe() {} disconnect() {} });
    vi.stubGlobal("getComputedStyle", () => ({ width: "800px" }));
    const element = { scrollLeft: 0, scrollTop: 0, scrollWidth: 10000, clientWidth: 800, clientHeight: 300, isConnected: true,
      getClientRects: () => [{}], addEventListener: (n: string, fn: (e: unknown) => void) => listeners.set(n, fn), removeEventListener: () => {}, querySelector: () => ({}) };
    const onviewportscroll = vi.fn();
    let columns!: ReturnType<typeof useListColumns>;
    const dispose = client.effect_root(() => {
      columns = create({ getRows: () => cardRows(40, 20), getPreferredRows: () => undefined, getPinnedPaths: () => [], onviewportscroll });
      columns.attach(element as unknown as HTMLElement);
    });
    client.flush(() => resize([{ contentRect: { width: 800, height: 300 } }]));
    await client.tick();
    onviewportscroll.mockClear();
    frame = undefined;
    columns.setCardScrollTop("/d/open", 30);
    columns.setCardScrollTop("/d/open", 60);
    columns.setCardScrollTop("/d/open", 60); // unchanged: no further work
    expect(frame).toBeDefined();
    client.flush(() => frame!(0));
    await client.tick();
    await client.tick();
    expect(onviewportscroll).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe("useListColumns scroll windowing", () => {
  let frame: FrameRequestCallback | undefined;
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frame = cb; return 1; });
    vi.stubGlobal("cancelAnimationFrame", () => { frame = undefined; });
  });
  afterEach(() => vi.unstubAllGlobals());
  const settle = () => { const f = frame; frame = undefined; client.flush(() => f?.(0)); };

  it("keeps the mounted item list identical while scrolling inside the mounted window", () => {
    // 10 rows per column, 400 entries -> 40 columns; the viewport shows ~3.
    const mounted = mount(entries(400), { width: 800, height: 300 });
    const before = mounted.columns.visibleItems;
    expect(before.length).toBeGreaterThan(0);
    for (const left of [1, 2, 3, 10, 24]) { mounted.scrollTo(left); settle(); }
    expect(mounted.columns.visibleItems).toBe(before);
    mounted.dispose();
  });

  it("mounts the columns under the viewport once the window actually moves", () => {
    const mounted = mount(entries(400), { width: 800, height: 300 });
    const first = mounted.columns.visibleItems.map(i => i.item.key);
    mounted.scrollTo(3000); settle();
    const after = mounted.columns.visibleItems.map(i => i.item.key);
    expect(after).not.toEqual(first);
    expect(after).toContain(`entry:/d/f${10 * Math.floor(3000 / 276)}`);
    mounted.dispose();
  });

  describe("wheel", () => {
    const fire = (mounted: ReturnType<typeof mount>, deltaX: number, deltaY: number) => {
      let prevented = false;
      mounted.wheel({ deltaX, deltaY, deltaMode: 0, ctrlKey: false, preventDefault: () => { prevented = true; } });
      return prevented;
    };
    it("scrolls by the same distance for fractional deltas in both directions", () => {
      const mounted = mount(entries(400), { width: 800, height: 300 });
      mounted.element.scrollLeft = 1000;
      for (let i = 0; i < 20; i++) fire(mounted, 0, 0.7);
      expect(mounted.element.scrollLeft).toBe(1013);
      for (let i = 0; i < 20; i++) fire(mounted, 0, -0.7);
      expect(mounted.element.scrollLeft).toBeCloseTo(1000, -1);
      expect(Math.abs(mounted.element.scrollLeft - 1000)).toBeLessThanOrEqual(1);
      mounted.dispose();
    });
    it("lets a card that can still scroll take a vertical wheel natively, then maps it sideways", () => {
      const mounted = mount(cardRows(40, 400), { width: 800, height: 300 });
      mounted.element.scrollLeft = 1000;
      const card = { scrollTop: 0, scrollHeight: 1200, clientHeight: 180 };
      const over = (deltaY: number) => {
        let prevented = false;
        mounted.wheel({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, target: { closest: () => card }, preventDefault: () => { prevented = true; } });
        return prevented;
      };
      Object.assign(mounted.element, { contains: (node: unknown) => node === card });
      expect(over(40)).toBe(false);
      expect(mounted.element.scrollLeft).toBe(1000);
      expect(over(-40)).toBe(true); // already at its top: the List scrolls back
      card.scrollTop = 1020; // its range end
      expect(over(40)).toBe(true);
      expect(over(-40)).toBe(false);
      mounted.dispose();
    });

    it("leaves horizontal gestures and edge overscroll to the browser", () => {
      const mounted = mount(entries(400), { width: 800, height: 300 });
      mounted.element.scrollLeft = 1000;
      expect(fire(mounted, 60, 5)).toBe(false);
      expect(mounted.element.scrollLeft).toBe(1000);
      mounted.element.scrollLeft = 0;
      expect(fire(mounted, 0, -40)).toBe(false);
      mounted.element.scrollLeft = 10000 - 800;
      expect(fire(mounted, 0, 40)).toBe(false);
      expect(fire(mounted, 0, -40)).toBe(true);
      mounted.dispose();
    });
  });
});
