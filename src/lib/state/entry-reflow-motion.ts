/**
 * DOM adapter for entry reflow motion (#1718): measure, mutate, measure again,
 * then glide each entry from where it was painted (FLIP). The pane creation
 * motion owns the lifetime and pauses, resumes and finishes these glides with
 * the reveal. Live glides are tracked here, so input handlers that settle the
 * motion cost nothing when no glide runs (no DOM-wide animation query).
 */
import { planEntryReflow, type EntryPosition } from "$lib/domain/entry-reflow";
import { PANE_CONTENT_HOLD_X } from "$lib/domain/pane-motion";
import { rectDimToCSS } from "$lib/domain/zoom";

export const ENTRY_REFLOW_ANIMATION = "entry-reflow";
/** A view whose layout cannot be fully measured in FileList's delivery opts
 * out with this attribute (Folder Peek panels size from a later observer). */
export const ENTRY_REFLOW_OFF = "data-entry-reflow-off";
const ENTRY = '[data-region="row"][data-path]';

export interface ReflowTiming {
  readonly duration: number;
  readonly easing: string;
}

const live = new Set<Animation>();
function glidesWithin(root: Element): Animation[] {
  if (live.size === 0) return [];
  return [...live].filter((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return !!target && root.contains(target);
  });
}

/** Painted positions, transforms included, so an interrupted glide continues
 * from where the user saw it. */
function measure(container: Element): Map<string, EntryPosition> {
  const positions = new Map<string, EntryPosition>();
  for (const element of container.querySelectorAll<HTMLElement>(ENTRY)) {
    const rect = element.getBoundingClientRect();
    positions.set(element.dataset.path!, { x: rect.left, y: rect.top });
  }
  return positions;
}

/** Run `mutate` (which must update the DOM synchronously) and glide every
 * entry that moved and is visible before or after. Rendered positions are
 * post-zoom viewport pixels; translations are CSS pixels. */
export function reflowEntries(container: HTMLElement, mutate: () => void, timing: ReflowTiming): void {
  const before = measure(container);
  finishEntryReflows(container);
  mutate();
  const after = measure(container);
  const steps = planEntryReflow(before, after);
  if (steps.length === 0) return;
  const view = container.getBoundingClientRect();
  const elements = new Map<string, HTMLElement>();
  for (const element of container.querySelectorAll<HTMLElement>(ENTRY)) elements.set(element.dataset.path!, element);
  for (const step of steps) {
    const element = elements.get(step.key);
    if (!element) continue;
    // Buffer rows off screen at both ends need no layer of their own.
    const { width, height } = element.getBoundingClientRect();
    const shown = (position: EntryPosition | undefined) => !!position
      && position.y + height > view.top && position.y < view.bottom
      && position.x + width > view.left && position.x < view.right;
    if (!shown(before.get(step.key)) && !shown(after.get(step.key))) continue;
    const animation = element.animate(
      [{ transform: `translate(${rectDimToCSS(step.dx)}px, ${rectDimToCSS(step.dy)}px)` }, { transform: "none" }],
      { ...timing, id: ENTRY_REFLOW_ANIMATION },
    );
    live.add(animation);
    const forget = () => live.delete(animation);
    animation.finished.then(forget, forget);
  }
}

/** CSS px a held pane frame extends beyond its final bounds (0 when settled). */
export function contentHold(element: Element): number {
  const value = parseFloat(getComputedStyle(element).getPropertyValue(PANE_CONTENT_HOLD_X));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** A reflow glides only while its pane's frame is held for a reveal, and only
 * when the view can be measured completely in this delivery. */
export function reflowTiming(container: HTMLElement, timing: ReflowTiming): ReflowTiming | undefined {
  if (contentHold(container) <= 0 || container.querySelector(`[${ENTRY_REFLOW_OFF}]`)) return undefined;
  return timing;
}

export const hasEntryReflows = (root: Element) => glidesWithin(root).length > 0;
export const pauseEntryReflows = (root: Element) => { for (const a of glidesWithin(root)) a.pause(); };
export const resumeEntryReflows = (root: Element) => {
  for (const a of glidesWithin(root)) if (a.playState === "paused") a.play();
};
export function finishEntryReflows(root: Element): void {
  for (const animation of glidesWithin(root)) {
    live.delete(animation);
    animation.cancel();
  }
}
