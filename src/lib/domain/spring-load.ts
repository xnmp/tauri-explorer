/**
 * Spring-loaded folder peek (#1242, spec §5): holding a drag over a closed
 * folder for SPRING_LOAD_DELAY_MS opens a temporary peek; leaving both the
 * folder and its peek closes it, and so does the drag ending. A pure state
 * machine over plain observations, so every drag backend (HTML5 DOM, native
 * receiver, pointer drag) drives the same rules; the timer is injected.
 */
import type { PeekCapability } from "./folder-peek-flat";

/** Hover time before a closed folder springs open (spec §13: tunable). */
export const SPRING_LOAD_DELAY_MS = 600;

export interface SpringTarget { readonly pane: string; readonly path: string }

/** A folder row under the pointer, with what decides whether it may spring open. */
export interface SpringFolder {
  readonly path: string;
  /** 0 for an entry of the pane's current folder. */
  readonly depth: number;
  readonly capability: PeekCapability;
  /** Already open as an ordinary (user-expanded) peek. */
  readonly expanded: boolean;
  /** A plain filesystem location (not virtual or provider-owned). */
  readonly plain: boolean;
}

/** What is under the drag point. `anchors` are the paths of the rows and peek
 * surfaces containing the point in `pane`: the point is inside an open peek
 * when an anchor is its folder or lies below it. */
export interface SpringObservation {
  readonly pane: string | null;
  readonly anchors: readonly string[];
  readonly folder: SpringFolder | null;
  /** Paths being dragged: a folder cannot spring open over itself or inside itself. */
  readonly dragged: readonly string[];
}

export interface SpringState {
  /** Open temporary peeks, outer first. */
  readonly open: readonly SpringTarget[];
  /** The folder whose delay is running. */
  readonly pending: SpringTarget | null;
}

export type SpringEvent =
  | { readonly type: "hover"; readonly observation: SpringObservation }
  | { readonly type: "elapsed"; readonly target: SpringTarget }
  /** A pane dropped its temporary peeks itself (navigation) or closed. */
  | { readonly type: "reset"; readonly pane: string }
  | { readonly type: "end" };

/** `pathComparison`: `key` is null for a path the platform cannot name;
 * `contains(child, parent)` means child is parent or below it. */
export interface SpringPaths {
  key(path: string): string | null;
  same(a: string, b: string): boolean;
  contains(child: string, parent: string): boolean;
}

export const springIdle: SpringState = { open: [], pending: null };

const sameTarget = (paths: SpringPaths, a: SpringTarget | null, b: SpringTarget | null) =>
  a === b || (!!a && !!b && a.pane === b.pane && paths.same(a.path, b.path));

/** Whether the point described by `observation` lies inside `target`'s folder row or peek. */
export function springInside(paths: SpringPaths, target: SpringTarget, observation: SpringObservation): boolean {
  return observation.pane === target.pane && observation.anchors.some(anchor => paths.contains(anchor, target.path));
}

/** The folder under the pointer, if it may spring open now. */
export function springCandidate(paths: SpringPaths, open: readonly SpringTarget[], observation: SpringObservation): SpringTarget | null {
  const folder = observation.folder;
  if (!observation.pane || !folder || paths.key(folder.path) === null || !folder.plain || folder.expanded) return null;
  // Tiles panels show top-level folders only; Details and List nest.
  if (folder.capability === "none" || (folder.capability === "top-level" && folder.depth !== 0)) return null;
  if (observation.dragged.some(source => paths.contains(folder.path, source))) return null;
  const target = { pane: observation.pane, path: folder.path };
  return open.some(item => sameTarget(paths, item, target)) ? null : target;
}

export function stepSpringLoad(state: SpringState, event: SpringEvent, paths: SpringPaths): SpringState {
  if (event.type === "end") return state.open.length || state.pending ? springIdle : state;
  if (event.type === "reset") {
    const open = state.open.filter(target => target.pane !== event.pane);
    const pending = state.pending?.pane === event.pane ? null : state.pending;
    return open.length === state.open.length && pending === state.pending ? state : { open, pending };
  }
  if (event.type === "elapsed") {
    if (!sameTarget(paths, state.pending, event.target)) return state;
    return { open: [...state.open, state.pending!], pending: null };
  }
  const { observation } = event;
  // Leaving a peek closes it and every temporary peek opened inside it.
  const closed = state.open.filter(target => !springInside(paths, target, observation));
  const open = closed.length
    ? state.open.filter(target => !closed.some(gone => gone.pane === target.pane && paths.contains(target.path, gone.path)))
    : state.open;
  const candidate = springCandidate(paths, open, observation);
  const pending = sameTarget(paths, candidate, state.pending) ? state.pending : candidate;
  return open === state.open && pending === state.pending ? state : { open, pending };
}

export interface SpringTimer {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SpringLoadControllerOptions {
  readonly paths: SpringPaths;
  /** Receives the open temporary peeks whenever they change. */
  readonly apply: (open: readonly SpringTarget[]) => void;
  readonly delay?: number;
  /** How long `endSoon` waits for the native receiver's Drop or Leave. */
  readonly lostLeaveMs?: number;
  /** The gesture ended (an `end`, a lost-Leave fallback or a newer drag). */
  readonly onEnd?: () => void;
  /** True while something still needs the peeks as they are (a pending drop's
   * hold): the lost-Leave fallback then waits for `endDeferred`. */
  readonly keepOpen?: () => boolean;
  readonly timer?: SpringTimer;
}

/** Wait for a native Drop or Leave after the source's dragend (#1269): a lost
 * Leave must not leave a temporary peek open until the next drag. */
export const SPRING_LOST_LEAVE_MS = 500;

export const defaultSpringTimer: SpringTimer = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Owns the one spring timer around `stepSpringLoad`, and the identity of the
 * drag gesture the state belongs to (#1269). A caller that outlives its
 * gesture (a replayed drop, a lost-Leave fallback) passes the gesture it
 * captured, so it can only end the springs it saw: a newer drag's hover
 * retires the older gesture and everything scoped to it.
 */
export function createSpringLoadController(options: SpringLoadControllerOptions) {
  const { paths, apply, delay = SPRING_LOAD_DELAY_MS, lostLeaveMs = SPRING_LOST_LEAVE_MS, timer = defaultSpringTimer, onEnd, keepOpen } = options;
  let state = springIdle;
  let handle: unknown = null;
  let armed: SpringTarget | null = null;
  let gesture: string | undefined;
  let fallback: unknown = null;
  let deferred: string | null = null;

  function dispatch(event: SpringEvent): void {
    const previous = state;
    state = stepSpringLoad(state, event, paths);
    if (state.pending !== armed) {
      if (handle !== null) timer.clear(handle);
      handle = null;
      armed = state.pending;
      if (armed) {
        const target = armed;
        handle = timer.set(() => { handle = null; dispatch({ type: "elapsed", target }); }, delay);
      }
    }
    if (state.open !== previous.open) apply(state.open);
  }

  function cancelFallback(): void {
    if (fallback !== null) timer.clear(fallback);
    fallback = null;
    deferred = null;
  }

  /** Ends the gesture; false when `scope` names an older one. */
  function end(scope?: string): boolean {
    if (scope !== undefined && scope !== gesture) return false;
    cancelFallback();
    gesture = undefined;
    dispatch({ type: "end" });
    onEnd?.();
    return true;
  }

  return {
    /** `scope` names the drag: one differing from the last hover's is a new
     * drag, which ends the earlier one. */
    hover(observation: SpringObservation, scope?: string): void {
      const fresh = scope !== undefined && scope !== gesture;
      if (fresh) { end(); gesture = scope; }
      dispatch({ type: "hover", observation });
    },
    reset(pane: string): void { dispatch({ type: "reset", pane }); },
    /** End every temporary peek; with `scope`, only if it is still the live gesture. */
    end,
    /** The source ended but the native receiver may still report this gesture:
     * end it unless `settle`, an `end` or a new gesture comes first. */
    endSoon(): void {
      cancelFallback();
      const scope = gesture;
      if (scope === undefined) return;
      fallback = timer.set(() => {
        fallback = null;
        if (keepOpen?.()) deferred = scope; else end(scope);
      }, lostLeaveMs);
    },
    /** A `keepOpen` reason went away: complete a fallback that was waiting. */
    endDeferred(): void {
      const waiting = deferred;
      if (!waiting || keepOpen?.()) return;
      deferred = null;
      end(waiting);
    },
    /** The native receiver delivered its Drop or Leave: no fallback needed. */
    settle(): void { cancelFallback(); },
    get gesture(): string | undefined { return gesture; },
    get state(): SpringState { return state; },
  };
}
