import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileModule } from "svelte/compiler";
import ts from "typescript";
import * as client from "svelte/internal/client";
import * as panels from "$lib/domain/tile-panels";
import * as navigation from "$lib/domain/tile-panel-navigation";
import * as motion from "$lib/domain/tile-panel-motion";
import * as listMotion from "$lib/domain/list-motion";
import { TILE_GRID_PAD_X } from "$lib/domain/tile-layout";
import { createRafCoalescer } from "$lib/domain/raf-coalesce";
import { dropHover } from "$lib/state/drop-hover";
import type { useTilePanels } from "$lib/composables/use-tile-panels.svelte";
import { MEDIUM, P, ROOT, rowsFor, widthFor } from "../domain/tile-panels-fixture";

// Run the production composable against Svelte's client runtime (Vitest's SSR
// transform drops effects), as tests/composables/use-list-columns.test.ts does.
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

const destroyers: (() => void)[] = [];
const destroy = () => { for (const fn of destroyers.splice(0)) fn(); };
const svelte = {
  flushSync: (fn?: () => void) => client.flush(fn),
  tick: client.tick, untrack: client.untrack, onDestroy: (fn: () => void) => { destroyers.push(fn); },
};
const create = new Function("$", "svelte", "panels", "navigation", "motion", "listMotion", "TILE_GRID_PAD_X", "createRafCoalescer", "dropHover", "dialogStore", "rectDimToCSS",
  `const { flushSync, onDestroy, tick, untrack } = svelte;
   const { buildTilePanelModel, clampPreferredHeight, gripKeyHeight, groupOffsets, placementSides, PANEL_PAD_Y } = panels;
   const { panelRevealTop, panelRowTop, resolveTileMove } = navigation;
   const { anchoredScrollTop, canAnimate, easeOutCubic, geometryChanged, leavingPaths, mixGeometry, TILE_MOTION_MS } = motion;
   const { motionArmAt, stepMotionArm } = listMotion;
   ${compileClient("../../src/lib/composables/use-tile-panels.svelte.ts")}
   return useTilePanels;`)(client, svelte, panels, navigation, motion, listMotion, TILE_GRID_PAD_X, createRafCoalescer, dropHover,
  { renamingEntry: null }, (value: number) => value) as typeof useTilePanels;

/** A window whose listeners a test can count and fire. */
function stubWindow() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  vi.stubGlobal("window", {
    addEventListener: (name: string, fn: (event: unknown) => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener: (name: string, fn: (event: unknown) => void) => listeners.get(name)?.delete(fn),
  });
  return {
    fire: (name: string, event: object = {}) => client.flush(() => { for (const fn of [...listeners.get(name) ?? []]) fn(event); }),
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

/** The panels composable over a fake pane whose open folders and remembered heights a test controls. */
function mount(open: readonly string[]) {
  const version = client.state(0);
  let current = rowsFor(open);
  let order = open.map(P);
  const heights = new Map<string, number>();
  const commits: [string, number][] = [];
  const bump = () => client.flush(() => client.set(version, client.get(version) + 1));
  const explorer = {
    get detailRows() { client.get(version); return current.rows; },
    get expandedPaths() { client.get(version); return new Set(order); },
    get displayEntries() { client.get(version); return current.tree.entries; },
    peekChange: null,
    currentPath: ROOT,
    peekStatus: () => "loaded",
    tilePanelHeight: (path: string) => { client.get(version); return heights.get(path); },
    setTilePanelHeight: (path: string, height: number) => { heights.set(path, height); commits.push([path, height]); bump(); },
    // The session's side memory (plain here: the composable never tracks it).
    tilePanelSides: new Map(),
    rememberTilePanelSides(sides: ReadonlyMap<string, unknown>) { this.tilePanelSides = new Map(sides); },
  };
  const viewport = {
    scrollTop: 0, clientHeight: 1000, isConnected: true, getClientRects: () => [{}], scrollTo: () => {},
  };
  let tiles!: ReturnType<typeof useTilePanels>;
  const dispose = client.effect_root(() => {
    tiles = create({
      getExplorer: () => explorer as never, getColumns: () => 7, getLayout: () => MEDIUM,
      getContentWidth: () => widthFor(7) + TILE_GRID_PAD_X, getViewport: () => viewport as never,
    });
  });
  tiles.setViewportSize({ width: widthFor(7), height: 1000 });
  client.flush();
  const box = (path: string) => {
    const spec = tiles.model.panels.get(P(path));
    return spec ? tiles.model.geometry[spec.row].boxes.find(b => b.path === P(path)) ?? null : null;
  };
  return {
    tiles, commits, box,
    setOpen(next: readonly string[]) { current = rowsFor(next); order = next.map(P); bump(); },
    unmount() { destroy(); dispose(); },
    dispose,
  };
}

describe("useTilePanels grip session", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => { destroy(); vi.unstubAllGlobals(); });

  it("previews the whole band from window moves and commits on a window release, whatever is mounted", () => {
    const win = stubWindow();
    const mounted = mount(["Career", "Personal"]);
    const { tiles, box } = mounted;
    // Both members take the band's height (its tallest member's), so a grip
    // on either previews and commits it for both.
    const start = box("Personal")!.height;
    expect(box("Career")!.height).toBe(start);
    tiles.beginGrip(P("Personal"), 7, 100);
    win.fire("pointermove", { pointerId: 8, clientY: 10 }); // another pointer
    expect(tiles.gripping(P("Personal"))).toBe(false);
    win.fire("pointermove", { pointerId: 7, clientY: 60 });
    // A below band's far edge is its bottom: moving up shrinks every member.
    expect(tiles.gripping(P("Career"))).toBe(true);
    expect(box("Career")!.height).toBe(start - 40);
    expect(box("Personal")!.height).toBe(start - 40);
    expect(mounted.commits).toEqual([]);
    // The release is a window event, so it lands though the grip itself may
    // have unmounted (the band scrolled out of the virtual window).
    win.fire("pointerup", { pointerId: 7, clientY: 60 });
    expect(mounted.commits).toEqual([[P("Career"), start - 40], [P("Personal"), start - 40]]);
    expect(tiles.gripping(P("Personal"))).toBe(false);
    expect(box("Personal")!.height).toBe(start - 40);
    expect(win.count()).toBe(0);
    mounted.dispose();
  });

  it("grows an above band's grip upward, its far edge", () => {
    const win = stubWindow();
    const mounted = mount(["Career", "Personal", "Inbox"]);
    const { tiles, box } = mounted;
    expect(box("Inbox")!.side).toBe("above");
    const start = box("Inbox")!.height;
    tiles.beginGrip(P("Inbox"), 1, 100);
    win.fire("pointermove", { pointerId: 1, clientY: 130 }); // down: shrinks an above band
    expect(box("Inbox")!.height).toBe(start - 30);
    win.fire("pointerup", { pointerId: 1, clientY: 130 });
    expect(mounted.commits).toEqual([[P("Inbox"), start - 30]]);
    mounted.dispose();
  });

  it("drops the preview without committing on cancel, blur, a closed panel or unmount, and removes its listeners", () => {
    const win = stubWindow();
    const mounted = mount(["Career"]);
    const { tiles, box } = mounted;
    const start = box("Career")!.height;
    for (const end of [() => win.fire("blur"), () => win.fire("pointercancel", { pointerId: 1 })]) {
      tiles.beginGrip(P("Career"), 1, 100);
      win.fire("pointermove", { pointerId: 1, clientY: 70 });
      expect(box("Career")!.height).toBe(start - 30);
      end();
      expect(tiles.gripping(P("Career"))).toBe(false);
      expect(box("Career")!.height).toBe(start);
      expect(win.count()).toBe(0);
    }
    // A panel closed mid-drag never delivers its grip's release.
    tiles.beginGrip(P("Career"), 1, 100);
    win.fire("pointermove", { pointerId: 1, clientY: 70 });
    mounted.setOpen([]);
    expect(win.count()).toBe(0);
    mounted.setOpen(["Career"]);
    expect(tiles.gripping(P("Career"))).toBe(false);
    expect(box("Career")!.height).toBe(start);
    tiles.beginGrip(P("Career"), 1, 100);
    expect(win.count()).toBeGreaterThan(0);
    mounted.unmount();
    expect(win.count()).toBe(0);
    win.fire("pointerup", { pointerId: 1, clientY: 400 });
    expect(mounted.commits).toEqual([]);
  });

  it("resizes from separator keys within the band's range and ignores closed folders", () => {
    const win = stubWindow();
    const mounted = mount(["Career"]);
    const { tiles, box } = mounted;
    const { min, max } = tiles.gripBounds(P("Career"));
    expect(max).toBe(box("Career")!.height); // Career's content is shorter than the default
    expect(tiles.gripKey(P("Career"), "End")).toBe(true);
    expect(mounted.commits).toEqual([]); // already at the clamp
    expect(tiles.gripKey(P("Career"), "Home")).toBe(true);
    expect(mounted.commits).toEqual([[P("Career"), min]]);
    expect(box("Career")!.height).toBe(min);
    expect(tiles.gripKey(P("Career"), "Enter")).toBe(false);
    expect(tiles.gripKey(P("Codex"), "End")).toBe(false);
    tiles.beginGrip(P("Codex"), 1, 100);
    expect(win.count()).toBe(0);
    mounted.dispose();
  });
});

describe("useTilePanels cells", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => { destroy(); vi.unstubAllGlobals(); });

  it("gives each row its own top-level tiles in order, indexed into the current display entries", () => {
    const mounted = mount([]);
    const { tiles } = mounted;
    const names = () => tiles.model.groups.flatMap(group => tiles.cells(group).map(cell => cell.entry?.name));
    expect(tiles.cells(tiles.model.groups[0]).map(cell => cell.entry?.name)).toEqual(["AI Draft Archive", "Archive", "Career", "Codex", "Inbox", "Personal", "Revenue NSW.pdf"]);
    const top = names();
    expect(tiles.model.groups.flatMap(group => tiles.cells(group).map(cell => cell.index))).toEqual(top.map((_, i) => i));
    // Opening Career puts its children into the display entries after it: every
    // row keeps its top-level tiles, each indexing the entry it shows.
    mounted.setOpen(["Career"]);
    const entries = rowsFor(["Career"]).tree.entries;
    expect(names()).toEqual(top);
    for (const group of tiles.model.groups) {
      for (const cell of tiles.cells(group)) expect(entries[cell.index!]?.path).toBe(cell.entry!.path);
    }
    expect(tiles.cells(tiles.model.groups[1])[0].index).toBeGreaterThan(7);
    mounted.dispose();
  });
});
