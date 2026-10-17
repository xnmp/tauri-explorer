/**
 * Applies the pure List open/close plan (`domain/list-motion.ts`, #1240) to the
 * DOM. User peek toggles animate (an open stays armed while its listing loads);
 * every other layout change — refresh, navigation, restore, a card resize, a
 * change of rows per column — and reduced motion are instant.
 *
 * Ghost rule (spec §8.4): snapshots of departing items live only in the inert,
 * aria-hidden layer this composable owns. Clones lose every identity class and
 * data/ARIA attribute, so no live query (selection, marquee, drop targets,
 * focus) can reach them, and per-frame work touches only captured references.
 * Any new layout first finishes the running motion: ghosts removed, inline
 * styles cleared, so an interrupted toggle cannot leave a stuck frame.
 */
import { onDestroy, untrack } from "svelte";
import { LIST_COLUMN_STRIDE, LIST_SLOT_HEIGHT, type ListFlowModel } from "$lib/domain/list-column-flow";
import {
  columnClip, easeOutCubic, LIST_MOTION_MS, listMotionSnapshot, motionRows, planListMotion,
  type GhostMotion, type LiveMotion, type MotionSnapshot, type MotionStep,
} from "$lib/domain/list-motion";

interface ListMotionDeps {
  getModel: () => ListFlowModel;
  /** The pane's last user peek toggle (`explorer.peekChange`). */
  getChange: () => { path: string; serial: number } | null;
  /** Listing state of an open peek ("loading" until its first listing settles). */
  getStatus: (path: string) => string | undefined;
  /** Whether a column intersects the scrollport now. */
  columnVisible: (column: number) => boolean;
  getCanvas: () => HTMLElement | null;
  getLayer: () => HTMLElement | null;
  /** Bring an opened card fully into view. */
  revealCard: (path: string, smooth: boolean) => void;
}

/** An opened folder's listing may arrive after its toggle; it still animates. */
const ARM_MS = 1500;
/** Classes that make an element a target of live queries. */
const IDENTITY_CLASSES = ["entry-item", "list-item", "list-slot", "peek-drop-target", "drop-target"];

type Run =
  | { kind: "live"; el: HTMLElement; scroll: HTMLElement | null; top: number; motion: LiveMotion }
  | { kind: "ghost"; el: HTMLElement; scroll: HTMLElement | null; top: number; motion: GhostMotion };

function sanitize(root: HTMLElement): void {
  for (const node of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
    node.classList.remove(...IDENTITY_CLASSES);
    for (const name of node.getAttributeNames()) {
      if (name.startsWith("data-") || name.startsWith("aria-") || ["role", "tabindex", "id", "draggable", "name", "for"].includes(name)) node.removeAttribute(name);
    }
  }
}

const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useListMotion(deps: ListMotionDeps) {
  let last: MotionSnapshot | null = null;
  let seen = untrack(() => deps.getChange()?.serial ?? null);
  let armed: { path: string; until: number } | null = null;
  let pending: { steps: MotionStep[]; ghosts: Map<string, { el: HTMLElement; scrollTop: number }> } | null = null;
  let revealPath: string | null = null;
  let frame = 0;
  /** Live slots and card scroll areas carrying inline motion styles. */
  let touched: HTMLElement[] = [];
  let resized: HTMLElement[] = [];
  let ghosts: HTMLElement[] = [];
  let settleReveal: string | null = null;

  function liveSlots(canvas: HTMLElement): Map<string, HTMLElement> {
    const slots = new Map<string, HTMLElement>();
    for (const child of canvas.children) {
      const key = (child as HTMLElement).dataset?.motionKey;
      if (key !== undefined) slots.set(key, child as HTMLElement);
    }
    return slots;
  }

  /** End the running motion at its final frame. */
  function finish(reveal: boolean): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const ghost of ghosts) ghost.remove();
    ghosts = [];
    for (const el of touched) for (const property of ["transform", "clip-path", "visibility"]) el.style.removeProperty(property);
    for (const el of resized) el.style.removeProperty("height");
    touched = [];
    resized = [];
    const path = settleReveal;
    settleReveal = null;
    if (reveal && path) deps.revealCard(path, !prefersReducedMotion());
  }

  // Before the DOM update: decide, and clone what is leaving while the DOM
  // still shows the previous layout.
  $effect.pre(() => {
    const model = deps.getModel();
    const change = deps.getChange();
    untrack(() => {
      const next = listMotionSnapshot(model);
      const now = performance.now();
      const user = change !== null && change.serial !== seen;
      if (change) seen = change.serial;
      if (user) armed = { path: change.path, until: now + ARM_MS };
      if (armed && now > armed.until) armed = null;
      finish(false);
      const steps = armed && !prefersReducedMotion() ? planListMotion(last, next, deps.columnVisible) : null;
      const opened = armed && model.items.some(item => item.card?.path === armed!.path) ? armed.path : null;
      // The change that settles the folder's listing is its last animated one.
      if (armed && deps.getStatus(armed.path) !== "loading") armed = null;
      last = next;
      const canvas = deps.getCanvas();
      pending = steps && canvas ? { steps, ghosts: capture(steps, canvas) } : null;
      revealPath = opened;
    });
  });

  // After the DOM update, before paint: start from the first frame.
  $effect(() => {
    void deps.getModel();
    void deps.getChange();
    untrack(() => {
      const plan = pending, reveal = revealPath;
      pending = null;
      revealPath = null;
      if (plan && start(plan)) settleReveal = reveal;
      else if (reveal) deps.revealCard(reveal, !prefersReducedMotion());
    });
  });

  onDestroy(() => finish(false));

  function capture(steps: readonly MotionStep[], canvas: HTMLElement) {
    const slots = liveSlots(canvas);
    const captured = new Map<string, { el: HTMLElement; scrollTop: number }>();
    for (const step of steps) {
      const slot = step.ghost && slots.get(step.key);
      if (!slot) continue;
      const clone = slot.cloneNode(true) as HTMLElement;
      sanitize(clone);
      for (const child of clone.querySelectorAll(".list-card-grip, .list-card-more")) child.remove();
      captured.set(step.key, { el: clone, scrollTop: slot.querySelector<HTMLElement>("[data-card-scroll]")?.scrollTop ?? 0 });
    }
    return captured;
  }

  function start(plan: NonNullable<typeof pending>): boolean {
    const canvas = deps.getCanvas(), layer = deps.getLayer();
    if (!canvas || !layer || !last) return false;
    const slots = liveSlots(canvas);
    const columnHeight = last.R * LIST_SLOT_HEIGHT;
    const runs: Run[] = [];
    for (const step of plan.steps) {
      const placed = last.items.get(step.key);
      const el = step.live && slots.get(step.key);
      if (step.live && el && placed) {
        runs.push({ kind: "live", el, scroll: el.querySelector<HTMLElement>("[data-card-scroll]"), top: placed.row * LIST_SLOT_HEIGHT, motion: step.live });
      }
      const ghost = step.ghost && plan.ghosts.get(step.key);
      if (step.ghost && ghost) {
        ghost.el.style.left = `${step.ghost.column * LIST_COLUMN_STRIDE}px`;
        ghost.el.style.top = `${step.ghost.row * LIST_SLOT_HEIGHT}px`;
        layer.append(ghost.el);
        ghosts.push(ghost.el);
        const scroll = ghost.el.querySelector<HTMLElement>(".list-card-scroll");
        if (scroll) scroll.scrollTop = ghost.scrollTop;
        runs.push({ kind: "ghost", el: ghost.el, scroll, top: step.ghost.row * LIST_SLOT_HEIGHT, motion: step.ghost });
      }
    }
    if (!runs.length) return false;
    touched = runs.flatMap(run => run.kind === "live" ? [run.el] : []);
    resized = runs.flatMap(run => run.kind === "live" && run.scroll && run.motion.rowsFrom !== null ? [run.scroll] : []);
    const paint = (e: number) => {
      for (const run of runs) {
        const { motion } = run;
        const y = run.kind === "live" ? run.motion.from * (1 - e) : run.motion.to * e;
        const rows = motion.rowsFrom === null ? null : motionRows(motion.rowsFrom, motion.rowsTo, e);
        run.el.style.transform = `translateY(${y}px)`;
        if (run.scroll && rows !== null) run.scroll.style.height = `${rows * LIST_SLOT_HEIGHT}px`;
        if (run.kind === "live" && run.motion.hidden) run.el.style.visibility = "hidden";
        // Travelling items stay inside their column (conveyor); others never leave it.
        if (run.kind === "ghost" || run.motion.clipColumn !== null) {
          const height = (rows === null ? 0 : rows) * LIST_SLOT_HEIGHT + LIST_SLOT_HEIGHT;
          const clip = columnClip(run.top, y, height, columnHeight);
          run.el.style.clipPath = `inset(${clip.top}px -8px ${clip.bottom}px -8px)`;
        }
      }
    };
    paint(0);
    const started = performance.now();
    const step = (now: number) => {
      const t = (now - started) / LIST_MOTION_MS;
      if (t >= 1) { frame = 0; finish(true); return; }
      paint(easeOutCubic(t));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return true;
  }

  return {
    /** True while a motion is running (for diagnostics and tests). */
    get running() { return frame !== 0; },
  };
}
