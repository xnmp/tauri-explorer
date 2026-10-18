/**
 * Tiles with Folder Peek (#1241): wires the pure panel layout
 * (`domain/tile-panels.ts`) to the virtualized row groups. Owns the measured
 * scrollport size (committed inside ResizeObserver delivery, #1061), each
 * panel's scroll offset, the grip preview, hover emphasis, keyboard reveal and
 * the open/close motion.
 *
 * Motion (§9.5): only user toggles (`explorer.peekChange`, armed while the
 * opened listing loads, `stepMotionArm` as in List) animate, by mixing the
 * previous and next geometry each frame; a new toggle or grip press finishes
 * the running one first, and reduced motion, refreshes, resizes and grip drags
 * are instant. The opened panel is revealed once its listing settles, however
 * long that takes. The grip drag session lives here, ended by window
 * listeners, so a band that unmounts mid-drag cannot strand it (#444). A closing
 * panel renders as an inert ghost captured from the previous rows (ghost rule:
 * no identity classes, data or ARIA, so no live query or state update reaches
 * it). Whatever changes, the toggled (or dragged) folder's row — else the first
 * visible row — keeps its place on screen, so an above band never pushes its
 * row down.
 */
import { flushSync, onDestroy, tick, untrack } from "svelte";
import type { FileEntry } from "$lib/domain/file";
import type { PeekRows } from "$lib/domain/folder-peek";
import type { TileLayout } from "$lib/domain/tile-layout";
import type { ExplorerInstance } from "$lib/state/explorer.svelte";
import { dialogStore } from "$lib/state/dialogs.svelte";
import { dropHover } from "$lib/state/drop-hover";
import { createRafCoalescer } from "$lib/domain/raf-coalesce";
import { TILE_GRID_PAD_X } from "$lib/domain/tile-layout";
import { motionArmAt, stepMotionArm } from "$lib/domain/list-motion";
import { rectDimToCSS } from "$lib/domain/zoom";
import {
  buildTilePanelModel, clampPreferredHeight, gripKeyHeight, groupOffsets, placementSides, PANEL_PAD_Y,
  type BandSide, type GroupGeometry, type PanelBox, type TileGroup, type TilePanelModel,
} from "$lib/domain/tile-panels";
import { panelRevealTop, panelRowTop, resolveTileMove, type TileNavigationSnapshot } from "$lib/domain/tile-panel-navigation";
import { anchoredScrollTop, canAnimate, easeOutCubic, geometryChanged, leavingPaths, mixGeometry, TILE_MOTION_MS, type ScrollAnchor } from "$lib/domain/tile-panel-motion";

/** Mini rows mounted beyond a panel's visible area. */
const PANEL_OVERSCAN = 1;
/** The scroller's padding around the row groups. */
const PAD = TILE_GRID_PAD_X / 2;

const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A closing panel's content, captured from the rows it was built from. */
export interface TileGhost {
  readonly path: string;
  readonly folder: FileEntry;
  readonly cols: number;
  readonly track: number;
  readonly message: string | null;
  readonly itemCount: number;
  readonly scrollTop: number;
  /** The mounted window at close time, from content row `firstRow`. */
  readonly entries: readonly FileEntry[];
  readonly firstRow: number;
}

/** A grid cell: the creation sentinel (entry null) or a top-level entry. */
export interface TileCell { readonly key: string; readonly index: number | null; readonly entry: FileEntry | null }

/** A row kept fixed on screen across a geometry change; `reveal` is the panel
 * opening with it, whose top the anchor never scrolls past (spec §14). */
interface Anchor extends ScrollAnchor { group: number; reveal: string | null }

interface TilePanelsDeps {
  getExplorer: () => ExplorerInstance;
  getColumns: () => number;
  getLayout: () => TileLayout;
  /** FileList's content width: the row width until the scrollport is measured. */
  getContentWidth: () => number;
  getViewport: () => HTMLElement | null;
  onviewportscroll?: () => void;
  onlayoutchange?: () => void;
}

export function useTilePanels(deps: TilePanelsDeps) {
  const explorer = () => deps.getExplorer();

  // ---- Measured scrollport -------------------------------------------------
  let size = $state.raw({ width: 0, height: 0 });
  function setViewportSize(next: { width: number; height: number }): void {
    if (Math.abs(next.width - size.width) < 0.01 && next.height === size.height) return;
    // Inside ResizeObserver delivery: commit before paint (#1061).
    flushSync(() => { size = next; });
  }
  const width = $derived(size.width > 0 ? size.width : Math.max(0, deps.getContentWidth() - 16));
  const viewportHeight = $derived(size.height > 0 ? size.height : 600);

  // ---- Grip preview ----------------------------------------------------------
  let preview = $state.raw<{ paths: readonly string[]; height: number } | null>(null);
  /** The grip a pointer is dragging (its band height and side at the press). */
  let grip: { path: string; pointer: number; y: number; height: number; side: BandSide; stop: () => void } | null = null;

  // ---- Model -----------------------------------------------------------------
  const model = $derived.by(() => {
    const pane = explorer();
    const held = preview;
    return buildTilePanelModel({
      rows: pane.detailRows, order: pane.expandedPaths, columns: deps.getColumns(), width, viewportHeight,
      layout: deps.getLayout(),
      preferred: path => held?.paths.includes(path) ? held.height : pane.tilePanelHeight(path),
      // Sides from earlier layouts, kept while feasible (§9.1). The pane's peek
      // session holds them, so they outlive this view; untracked, because
      // remembering this layout's sides is no reason to rebuild it.
      remembered: untrack(() => pane.tilePanelSides),
    });
  });

  // ---- Motion state ------------------------------------------------------------
  let frame = $state.raw<readonly GroupGeometry[] | null>(null);
  let ghosts = $state.raw<ReadonlyMap<string, TileGhost>>(new Map());
  const geometry = $derived(frame ?? model.geometry);
  const offsets = $derived(groupOffsets(geometry.map(group => group.height)));

  // ---- Panel scroll offsets ----------------------------------------------------
  // A fine-grained proxy: one panel's scroll re-renders only that panel.
  const panelScroll = $state<Record<string, number>>({});
  const panelScrollTop = (path: string): number => panelScroll[path] ?? 0;
  const scrollWork = createRafCoalescer<void>(() => {
    void tick().then(() => { if (deps.getViewport()?.isConnected) { deps.onviewportscroll?.(); dropHover.refresh(); } });
  });
  function setPanelScrollTop(path: string, top: number): void {
    const value = Number.isFinite(top) ? Math.max(0, top) : 0;
    if (panelScroll[path] === value) return;
    panelScroll[path] = value;
    scrollWork.push();
  }

  // ---- VirtualList bindings ----------------------------------------------------
  let scrollToOffset = $state<((top: number) => void) | undefined>();
  let rowContainsIndex = $state<((group: number) => boolean) | undefined>();

  // ---- Anchoring -------------------------------------------------------------------
  function groupOfPath(m: TilePanelModel, path: string | null): number | null {
    if (!path) return null;
    const spec = m.panels.get(path);
    if (spec) return spec.row;
    const item = m.items.findIndex(it => it.key === `entry:${path}`);
    return item >= 0 ? Math.floor(item / m.metrics.columns) : null;
  }
  /** The row to keep fixed: `path`'s, else the first row on screen. */
  function captureAnchor(m: TilePanelModel, shown: readonly GroupGeometry[], path: string | null, reveal: string | null): Anchor | null {
    const viewport = deps.getViewport();
    if (!viewport || !viewport.getClientRects().length) return null;
    const scrollTop = viewport.scrollTop;
    const tops = groupOffsets(shown.map(g => g.height));
    let group = groupOfPath(m, path);
    if (group === null) {
      const visible = scrollTop - PAD;
      group = shown.findIndex((g, i) => tops[i] + g.rowTop + m.metrics.tileHeight > visible);
      if (group < 0) return null;
    }
    if (!shown[group]) return null;
    return { group, top: tops[group] + shown[group].rowTop, scrollTop, reveal };
  }
  /** Canvas top of `path`'s panel in the shown geometry, when it opens above its row. */
  function aboveTop(path: string | null): number | null {
    const row = path === null ? undefined : model.panels.get(path)?.row;
    const box = row === undefined ? undefined : geometry[row]?.boxes.find(b => b.path === path);
    return box?.side === "above" ? offsets[row!] + box.top : null;
  }
  function applyAnchor(anchor: Anchor | null): void {
    if (!anchor || !geometry[anchor.group]) return;
    const target = anchoredScrollTop(anchor, offsets[anchor.group] + geometry[anchor.group].rowTop, aboveTop(anchor.reveal));
    if (Math.abs(target - anchor.scrollTop) > 0.01 || Math.abs((deps.getViewport()?.scrollTop ?? anchor.scrollTop) - anchor.scrollTop) > 0.5) {
      scrollToOffset?.(target);
    }
  }

  // ---- Motion -----------------------------------------------------------------------
  let last: { model: TilePanelModel; rows: PeekRows } | null = null;
  let arm = motionArmAt(untrack(() => explorer().peekChange?.serial ?? null));
  let anchorPath: string | null = null;
  let pendingAnchor: Anchor | null = null;
  let pendingReveal: string | null = null;
  let running: { from: readonly GroupGeometry[]; to: readonly GroupGeometry[]; started: number; raf: number; anchor: Anchor | null; opened: string | null } | null = null;

  /** Stop the frame loop, keeping the current frame and ghosts (a retarget). */
  function stopFrames(): void {
    if (running) cancelAnimationFrame(running.raf);
    running = null;
  }
  /** End the running motion at its final frame. */
  function finishMotion(): void {
    if (!running && !frame && !ghosts.size) return;
    stopFrames();
    frame = null;
    if (ghosts.size) ghosts = new Map();
  }

  /** Ghosts for the panels leaving in a motion: those already leaving keep their
   * captured content; newly closed ones are captured from the previous rows. */
  function ghostsFor(leaving: ReadonlySet<string>, previous: { model: TilePanelModel; rows: PeekRows }): Map<string, TileGhost> {
    const next = new Map<string, TileGhost>();
    for (const path of leaving) {
      const kept = ghosts.get(path);
      if (kept) { next.set(path, kept); continue; }
      const spec = previous.model.panels.get(path);
      const box = spec && previous.model.geometry[spec.row]?.boxes.find(b => b.path === path);
      if (!spec || !box) continue;
      const window = panelRows(box, spec.contentRows, previous.model.tile.rowHeight, panelScrollTop(path));
      const entryAt = (index: number) => {
        const row = previous.rows.rows[previous.rows.entryToRow[index]];
        return row?.kind === "entry" ? row.entry : null;
      };
      const folder = entryAt(spec.entryIndex);
      if (!folder) continue;
      const entries = spec.entries.slice(window.start * spec.cols, window.end * spec.cols).flatMap(index => entryAt(index) ?? []);
      next.set(path, {
        path, folder, cols: spec.cols, track: spec.track, message: spec.message, itemCount: spec.entries.length,
        scrollTop: panelScrollTop(path), entries, firstRow: window.start,
      });
    }
    return next;
  }

  function startMotion(from: readonly GroupGeometry[], to: readonly GroupGeometry[], anchor: Anchor | null, opened: string | null): void {
    const state = { from, to, started: performance.now(), raf: 0, anchor, opened };
    running = state;
    frame = mixGeometry(from, to, 0);
    const step = (now: number) => {
      if (running !== state) return;
      // rAF timestamps can precede `started`; never step backwards.
      const t = Math.max(0, (now - state.started) / TILE_MOTION_MS);
      if (t >= 1) {
        finishMotion();
        flushSync();
        applyAnchor(state.anchor);
        if (state.opened) revealPanel(state.opened, !prefersReducedMotion());
        return;
      }
      frame = mixGeometry(state.from, state.to, easeOutCubic(t));
      flushSync();
      applyAnchor(state.anchor);
      state.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
  }

  // Before the DOM update: decide motion and capture the anchor while the DOM
  // and the previous geometry still agree.
  $effect.pre(() => {
    const next = model;
    const rows = explorer().detailRows;
    const change = explorer().peekChange;
    untrack(() => {
      const user = change !== null && change.serial !== arm.seen;
      // The toggled folder (armed for motion, or awaiting its reveal) keeps its row in place.
      const tracked = arm.armed?.path ?? arm.reveal;
      const step = stepMotionArm(arm, {
        change, now: performance.now(),
        status: path => explorer().peekStatus(path),
        cardOf: path => next.panels.has(path) ? path : null,
        // An interrupted motion still owes its reveal.
        carried: running?.opened ?? null,
      });
      arm = step.next;
      const previous = last;
      last = { model: next, rows };
      explorer().rememberTilePanelSides(placementSides(next.placements));
      // Forget scroll offsets of panels that closed (ghosts keep their own).
      for (const key of Object.keys(panelScroll)) if (!next.panels.has(key)) delete panelScroll[key];
      // A panel closed mid-drag never delivers its grip's release.
      if (grip && !next.panels.has(grip.path)) endGrip(null);
      if (!previous) return;
      const sameGrid = canAnimate(previous.model, next);
      const path = user ? change.path : anchorPath ?? tracked;
      const anchor = sameGrid ? captureAnchor(previous.model, frame ?? previous.model.geometry, path, step.reveal) : null;
      const animate = step.animate && sameGrid && !grip && !prefersReducedMotion();
      // A new toggle, and every change that does not animate, finishes the running motion.
      if (user || !animate) finishMotion();
      const from = frame ?? previous.model.geometry;
      if (animate && geometryChanged(from, next.geometry)) {
        // Retargeting a running motion starts from its current frame.
        const leaving = leavingPaths(from, next.geometry);
        const nextGhosts = ghostsFor(leaving, previous);
        stopFrames();
        ghosts = nextGhosts;
        startMotion(from, next.geometry, anchor, step.reveal);
        pendingAnchor = null;
      } else {
        finishMotion();
        pendingAnchor = anchor;
        pendingReveal = step.reveal;
      }
    });
  });

  // After the DOM update, before paint: keep the anchored row in place.
  $effect(() => {
    void model;
    untrack(() => {
      const anchor = pendingAnchor, reveal = pendingReveal;
      pendingAnchor = null;
      pendingReveal = null;
      applyAnchor(anchor);
      if (reveal) revealPanel(reveal, false);
    });
  });

  // FileList re-hit-tests (tab stop, marquee, drop hover) once a layout settles.
  $effect(() => {
    void model;
    if (frame) return;
    void tick().then(() => {
      if (deps.getViewport()?.isConnected) { deps.onlayoutchange?.(); dropHover.refresh(); }
    });
  });

  onDestroy(() => { endGrip(null); finishMotion(); scrollWork.cancel(); });

  // ---- Panel windows -------------------------------------------------------------
  /** Content rows to mount for a panel: its visible rows plus overscan. */
  function panelRows(box: PanelBox, contentRows: number, rowHeight: number, scrollTop: number): { start: number; end: number } {
    const start = Math.max(0, Math.floor((scrollTop - PANEL_PAD_Y) / rowHeight) - PANEL_OVERSCAN);
    const end = Math.min(contentRows, Math.ceil((scrollTop + box.height) / rowHeight) + PANEL_OVERSCAN);
    return { start, end: Math.max(start, end) };
  }
  /** Offsets (into the panel's entries) to mount: the window plus a renaming entry. */
  function panelOffsets(path: string, box: PanelBox): number[] {
    const spec = model.panels.get(path);
    if (!spec) return [];
    const { start, end } = panelRows(box, spec.contentRows, model.tile.rowHeight, panelScrollTop(path));
    const offsets: number[] = [];
    for (let i = start * spec.cols; i < Math.min(spec.entries.length, end * spec.cols); i++) offsets.push(i);
    const renaming = dialogStore.renamingEntry?.path;
    if (renaming) {
      const pinned = spec.entries.findIndex(index => explorer().displayEntries[index]?.path === renaming);
      if (pinned >= 0 && !offsets.includes(pinned)) offsets.push(pinned);
    }
    return offsets.sort((a, b) => a - b);
  }

  // ---- Reveal --------------------------------------------------------------------
  /** Scroll the outer list minimally so canvas range [top, bottom] is visible. */
  function revealRange(top: number, bottom: number, smooth = false): void {
    const viewport = deps.getViewport();
    if (!viewport || !viewport.getClientRects().length) return;
    const pad = PAD;
    const current = viewport.scrollTop, view = viewport.clientHeight - 2 * pad;
    let target = current;
    if (top < current || bottom - top > view) target = top;
    else if (bottom > current + view) target = bottom - view;
    if (Math.abs(target - current) < 0.5) return;
    if (smooth) viewport.scrollTo({ top: target, behavior: "smooth" });
    else scrollToOffset?.(target);
  }
  function revealPanel(path: string, smooth: boolean): void {
    const spec = model.panels.get(path);
    const box = spec && model.geometry[spec.row]?.boxes.find(b => b.path === path);
    if (!spec || !box) return;
    const tops = groupOffsets(model.geometry.map(g => g.height));
    const groupTop = tops[spec.row];
    const labelTop = box.side === "stacked" ? box.labelHeight : 0;
    revealRange(groupTop + box.top - labelTop, groupTop + box.top + box.height, smooth);
  }
  /** Reveal a displayEntries index: its grid row, or its panel row (scrolling the panel first). */
  function revealEntry(index: number): void {
    const at = model.location[index];
    if (!at) return;
    if (running) { finishMotion(); flushSync(); }
    const tops = groupOffsets(model.geometry.map(g => g.height));
    const group = model.geometry[at.group];
    if (!group) return;
    if (at.kind === "grid") {
      const top = tops[at.group] + group.rowTop;
      revealRange(top, top + model.metrics.tileHeight);
      return;
    }
    const spec = model.panels.get(at.path)!;
    const box = group.boxes.find(b => b.path === at.path);
    if (!box) return;
    const row = Math.floor(at.offset / spec.cols);
    const scroll = panelRevealTop(box, model.tile.rowHeight, row, panelScrollTop(at.path), spec.contentHeight);
    setPanelScrollTop(at.path, scroll);
    const panelTop = tops[at.group] + box.top;
    const itemTop = panelTop + panelRowTop(box, model.tile.rowHeight, row) - scroll;
    revealRange(Math.max(panelTop, itemTop), Math.min(panelTop + box.height, itemTop + model.tile.rowHeight));
  }
  function containsEntry(index: number): boolean {
    const at = model.location[index];
    if (!at || !rowContainsIndex?.(at.group)) return false;
    if (at.kind === "grid") return true;
    const box = geometry[at.group]?.boxes.find(b => b.path === at.path);
    return !!box && panelOffsets(at.path, box).includes(at.offset);
  }
  /** A stacked label scrolls its parent into view. */
  function revealParent(path: string): void {
    const spec = model.panels.get(path);
    if (!spec) return;
    const tops = groupOffsets(model.geometry.map(g => g.height));
    const top = tops[spec.row] + model.geometry[spec.row].rowTop;
    revealRange(top - 12, top + model.metrics.tileHeight + 12, !prefersReducedMotion());
  }

  // ---- Grip -------------------------------------------------------------------------
  function bandMembers(path: string) {
    const key = model.panels.get(path)?.bandKey;
    return key ? [...model.panels.values()].filter(p => p.bandKey === key) : [];
  }
  const bandPaths = (path: string): string[] => bandMembers(path).map(p => p.path);
  /** A band's settled height and its tallest member's content (the grip's range). */
  function bandExtent(path: string): { height: number; content: number } {
    const members = bandMembers(path);
    const boxes = members.length ? model.geometry[members[0].row]?.boxes ?? [] : [];
    const paths = new Set(members.map(p => p.path));
    return {
      height: Math.max(0, ...boxes.filter(b => paths.has(b.path)).map(b => b.height)),
      content: Math.max(0, ...members.map(p => p.contentHeight)),
    };
  }
  /** One grid row's cells, one array per row group for the model's lifetime:
   * a mounted row re-reads its cells whenever VirtualList hands it its item
   * again (every scroll frame), and fresh cell objects would update every
   * mounted tile's props each time (#1240 "mounted slot identity"). */
  const cellCache = $derived.by(() => {
    void model;
    void explorer().displayEntries;
    return new WeakMap<TileGroup, readonly TileCell[]>();
  });
  function cells(group: TileGroup): readonly TileCell[] {
    const cache = cellCache;
    const cached = cache.get(group);
    if (cached) return cached;
    const entries = explorer().displayEntries;
    const built = model.items.slice(group.start, group.end).map(item => ({
      key: item.key, index: item.entryIndex, entry: item.entryIndex === null ? null : entries[item.entryIndex] ?? null,
    }));
    cache.set(group, built);
    return built;
  }
  /** An open panel's grip: its side, band height and the range a drag may set. */
  function gripRange(path: string) {
    const spec = model.panels.get(path);
    const box = spec && model.geometry[spec.row]?.boxes.find(b => b.path === path);
    if (!spec || !box) return null;
    const { height, content } = bandExtent(path);
    return { side: box.side, height, content, max: Math.max(model.bounds.min, Math.min(model.bounds.max, content)) };
  }
  /** The band height a drag from `session` reaches at `clientY`: the far edge
   * grows away from the parent (down below it, up above it). */
  function dragHeight(session: NonNullable<typeof grip>, clientY: number, content: number): number {
    const direction = session.side === "above" ? -1 : 1;
    return clampPreferredHeight(session.height + direction * rectDimToCSS(clientY - session.y), content, model.bounds);
  }
  /** A grip's band keeps its row in place through its preview and commit. */
  function holdAnchor(path: string): void { anchorPath = path; }
  function releaseAnchor(path: string): void {
    // The final change (commit or preview reset) is still anchored.
    void tick().then(() => { if (anchorPath === path) anchorPath = null; });
  }
  /** Set the preferred height of every member of `path`'s band. */
  function commitBand(path: string, height: number): void {
    holdAnchor(path);
    for (const member of bandPaths(path)) explorer().setTilePanelHeight(member, height);
    releaseAnchor(path);
  }
  /** End the drag: commit at `clientY`, or cancel with null. */
  function endGrip(clientY: number | null): void {
    const session = grip;
    if (!session) return;
    grip = null;
    session.stop();
    const range = clientY === null ? null : gripRange(session.path);
    preview = null;
    if (range) commitBand(session.path, dragHeight(session, clientY!, range.content));
    else releaseAnchor(session.path);
  }
  /** Start dragging `path`'s grip. Window listeners own the drag's end, so a
   * band that unmounts mid-drag (scrolled out) still commits or cancels. */
  function beginGrip(path: string, pointer: number, clientY: number): void {
    endGrip(null);
    const range = gripRange(path);
    if (!range) return;
    finishMotion();
    holdAnchor(path);
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointer || !grip) return;
      const current = gripRange(path);
      if (!current) { endGrip(null); return; }
      preview = { paths: bandPaths(path), height: dragHeight(grip, event.clientY, current.content) };
    };
    const up = (event: PointerEvent) => { if (event.pointerId === pointer) endGrip(event.clientY); };
    // A blur (no pointerId) also ends the drag: the release may never arrive.
    const cancel = (event: Event) => { if ((event as Partial<PointerEvent>).pointerId === undefined || (event as PointerEvent).pointerId === pointer) endGrip(null); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    grip = { path, pointer, y: clientY, height: range.height, side: range.side, stop: () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    } };
  }
  /** Separator keys on a panel's grip; true when the key was the grip's. */
  function gripKey(path: string, key: string): boolean {
    const range = gripRange(path);
    if (!range) return false;
    const next = gripKeyHeight(key, range.side, range.height, range.content, model.tile, model.bounds);
    if (next === null) return false;
    if (next !== Math.round(range.height)) { finishMotion(); commitBand(path, next); }
    return true;
  }

  // ---- Hover -------------------------------------------------------------------------
  let hot = $state<string | null>(null);

  return {
    get model() { return model; },
    /** The geometry on screen: the model's, or a motion frame. */
    get geometry() { return geometry; },
    get offsets() { return offsets; },
    get ghosts() { return ghosts; },
    get compact() { return frame !== null; },
    get running() { return running !== null; },
    setViewportSize,
    panelScrollTop, setPanelScrollTop, panelOffsets,
    gripping(path: string): boolean { return !!preview?.paths.includes(path); },
    bandExtent, cells,
    beginGrip, gripKey,
    /** The grip's aria-valuemin/max for an open panel. */
    gripBounds: (path: string) => ({ min: model.bounds.min, max: gripRange(path)?.max ?? model.bounds.min }),
    get hot() { return hot; },
    setHot(path: string | null) { if (hot !== path) hot = path; },
    revealEntry, containsEntry, revealParent,
    /** Toggles from panel controls (×) finish a running motion first, like the caret. */
    finishMotion,
    navigation(): TileNavigationSnapshot | null {
      const m = model;
      if (!m.panels.size) return null;
      const pane = explorer();
      const state = { model: m, geometry: m.geometry, panelScrollTop };
      return { entries: pane.displayEntries, directory: pane.currentPath, resolve: (event, cursor) => resolveTileMove(state, event, cursor) };
    },
    get scrollToOffset() { return scrollToOffset; },
    set scrollToOffset(fn: ((top: number) => void) | undefined) { scrollToOffset = fn; },
    get rowContainsIndex() { return rowContainsIndex; },
    set rowContainsIndex(fn: ((group: number) => boolean) | undefined) { rowContainsIndex = fn; },
  };
}
