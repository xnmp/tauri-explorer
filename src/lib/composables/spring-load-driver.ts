/**
 * Spring-loaded peek driver (#1242), loaded on the first eligible drag hover
 * through `spring-load.ts`. It turns the element under a drag into a
 * `SpringObservation`, runs the pure controller (`domain/spring-load.ts`) and
 * applies its open temporary peeks to each pane.
 *
 * Applies run one macrotask after the controller changes. Browsers run
 * microtasks between event listeners, so a synchronous close would re-render
 * before a DOM drop's own target handler (or a native Drop's position
 * resolution) has read the row under the pointer. A hold (a DOM drop deferred
 * behind a pending native start) keeps the peeks as they are until released.
 */
import { createSpringLoadController, type SpringObservation, type SpringPaths, type SpringTarget, type SpringTimer } from "$lib/domain/spring-load";
import type { PeekCapability } from "$lib/domain/folder-peek-flat";

/** The DOM surface observation reads, so it is testable without a DOM. */
export interface SpringHitElement {
  closest(selector: string): SpringHitElement | null;
  getAttribute(name: string): string | null;
}

/** What a pane tells observation about one of its folder rows. */
export interface SpringPaneView {
  readonly peekCapability: PeekCapability;
  readonly entryMeta: ReadonlyMap<string, { readonly depth: number }>;
  isPeekExpanded(path: string): boolean;
}

export interface SpringHitDeps {
  pane(id: string): SpringPaneView | undefined;
  /** A plain filesystem location (not virtual or provider-owned). */
  plain(path: string): boolean;
  /** A modal or dialog owns the surface under the point. */
  blocked(element: SpringHitElement): boolean;
  /** Paths of the live in-app drag (empty for an external drag). */
  dragged(): readonly string[];
}

const MOTION_ENTRY = "entry:";

/**
 * The observation for the element under a drag. The point belongs to a pane
 * only inside that pane's file listing (`.file-list .content`). Its anchors are
 * the identities containing it there: the nearest `[data-path]` (a row, a mini
 * tile, a List card's scroll area or peek-state row, a Tiles panel), a Details
 * peek-state row's folder, the nearest `[data-panel-owner]` (a Tiles panel,
 * ribbon or band bridge) and the nearest List slot (a card's header, scroll
 * area, grip and ring together).
 * Identity, not geometry, so no coordinate spaces are compared.
 */
export function observeSpringHit(element: SpringHitElement | null, deps: SpringHitDeps): SpringObservation {
  const dragged = deps.dragged();
  const content = element?.closest(".content") ?? null;
  const paneId = content?.closest(".file-list") ? content.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null : null;
  const view = paneId ? deps.pane(paneId) : undefined;
  if (!element || !content || !paneId || !view || deps.blocked(element)) return { pane: null, anchors: [], folder: null, dragged };
  const within = (node: SpringHitElement | null) => node && node.closest(".content") === content ? node : null;
  const anchors: string[] = [];
  const add = (value: string | null | undefined) => { if (value) anchors.push(value); };
  add(within(element.closest("[data-path]"))?.getAttribute("data-path"));
  add(within(element.closest("[data-peek-state]"))?.getAttribute("data-peek-state"));
  // A Details row wrapper: hit at a row's pixel-snapped edge.
  add(within(element.closest("[data-row-path]"))?.getAttribute("data-row-path"));
  add(within(element.closest("[data-panel-owner]"))?.getAttribute("data-panel-owner"));
  const key = within(element.closest(".list-slot[data-motion-key]"))?.getAttribute("data-motion-key");
  if (key?.startsWith(MOTION_ENTRY)) add(key.slice(MOTION_ENTRY.length));
  const path = within(element.closest(".entry-item.directory[data-path]"))?.getAttribute("data-path");
  const meta = path ? view.entryMeta.get(path) : undefined;
  const folder = path && meta
    ? { path, depth: meta.depth, capability: view.peekCapability, expanded: view.isPeekExpanded(path), plain: deps.plain(path) }
    : null;
  return { pane: paneId, anchors, folder, dragged };
}

export interface SpringLoadDriverDeps<E> {
  paths: SpringPaths;
  observe(element: E | null): SpringObservation;
  /** Set a pane's temporary peeks, outer first ([] closes them). */
  apply(pane: string, paths: readonly string[]): void;
  timer?: SpringTimer;
  /** Runs an apply one macrotask later (see the module comment). */
  defer?: (run: () => void) => void;
}

export interface SpringLoadDriver<E = Element> {
  hover(element: E | null): void;
  end(): void;
  /** Keep the applied peeks until the returned release runs (idempotent). */
  hold(): () => void;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((path, i) => path === b[i]);

export function createSpringLoadDriver<E>(deps: SpringLoadDriverDeps<E>): SpringLoadDriver<E> {
  const defer = deps.defer ?? (run => { setTimeout(run, 0); });
  let wanted: readonly SpringTarget[] = [];
  const applied = new Map<string, readonly string[]>();
  let holds = 0;
  let scheduled = false;

  function flush(): void {
    scheduled = false;
    if (holds) return;
    const next = new Map<string, string[]>();
    for (const target of wanted) next.set(target.pane, [...(next.get(target.pane) ?? []), target.path]);
    for (const pane of new Set([...applied.keys(), ...next.keys()])) {
      const paths = next.get(pane) ?? [];
      if (sameList(paths, applied.get(pane) ?? [])) continue;
      if (paths.length) applied.set(pane, paths); else applied.delete(pane);
      deps.apply(pane, paths);
    }
  }
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    defer(flush);
  }
  const controller = createSpringLoadController({
    paths: deps.paths, timer: deps.timer,
    apply: open => { wanted = open; schedule(); },
  });

  return {
    hover(element) { controller.hover(deps.observe(element)); },
    end() { controller.end(); },
    hold() {
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--holds === 0) schedule();
      };
    },
  };
}

export interface SpringDomDeps extends SpringHitDeps {
  paths: SpringPaths;
  apply(pane: string, paths: readonly string[]): void;
}

/** The production driver. Its eager dependencies are passed in by the
 * facade: importing them here would make the bundler split them out of the
 * startup chunks they share (#1242). */
export function createDomSpringLoadDriver(deps: SpringDomDeps): SpringLoadDriver {
  return createSpringLoadDriver<Element>({
    paths: deps.paths,
    observe: element => observeSpringHit(element as unknown as SpringHitElement | null, deps),
    apply: deps.apply,
  });
}
