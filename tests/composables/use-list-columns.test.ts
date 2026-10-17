import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import * as client from "svelte/internal/client";
import * as flow from "$lib/domain/list-column-flow";
import { dropHover } from "$lib/state/drop-hover";
import { createRafCoalescer } from "$lib/domain/raf-coalesce";
import type { useListColumns } from "$lib/composables/use-list-columns.svelte";
import type { FileEntry } from "$lib/domain/file";

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
const create = new Function("$", "svelte", "flow", "dropHover", "createRafCoalescer",
  `const { flushSync, getAbortSignal, onDestroy, tick, untrack } = svelte;
   const { ${Object.keys(flow).join(", ")} } = flow;
   ${compileClient("../../src/lib/composables/use-list-columns.svelte.ts")}
   return useListColumns;`)(client, svelte, flow, dropHover, createRafCoalescer) as typeof useListColumns;

const entries = (n: number): FileEntry[] => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, path: `/d/f${i}`, isDir: false, size: 1, modified: 0 }) as FileEntry);

function mount(items: readonly FileEntry[], size: { width: number; height: number }) {
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
    columns = create({ getItems: () => items, getPinnedPaths: () => [] });
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
    const first = mounted.columns.visibleItems.map(i => i.entry.path);
    mounted.scrollTo(3000); settle();
    const after = mounted.columns.visibleItems.map(i => i.entry.path);
    expect(after).not.toEqual(first);
    expect(after).toContain(`/d/f${10 * Math.floor(3000 / 276)}`);
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
