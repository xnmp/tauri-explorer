/**
 * DOM adapter for entry reflow motion (#1718): measure, mutate, measure again,
 * then glide each entry from where it was painted (FLIP). The pane creation
 * motion owns the lifetime; it finds these animations by their id to pause,
 * resume and finish them with the reveal.
 */
import { planEntryReflow, type EntryPosition } from "$lib/domain/entry-reflow";
import { PANE_CONTENT_HOLD_X } from "$lib/domain/pane-motion";

export const ENTRY_REFLOW_ANIMATION = "entry-reflow";
const ENTRY = '[data-region="row"][data-path]';

export interface ReflowTiming {
  readonly duration: number;
  readonly easing: string;
}

const reflowAnimations = (root: Element): Animation[] =>
  root.getAnimations({ subtree: true }).filter((animation) => animation.id === ENTRY_REFLOW_ANIMATION);

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

/** Run `mutate` (which must update the DOM synchronously) and animate every
 * entry that moved. Positions are viewport pixels on both sides, and the
 * translation is divided by the element's zoom so it lands in CSS pixels. */
export function reflowEntries(container: HTMLElement, mutate: () => void, timing: ReflowTiming): void {
  const before = measure(container);
  for (const animation of reflowAnimations(container)) animation.cancel();
  mutate();
  const after = measure(container);
  const steps = planEntryReflow(before, after);
  if (steps.length === 0) return;
  const elements = new Map<string, HTMLElement>();
  for (const element of container.querySelectorAll<HTMLElement>(ENTRY)) elements.set(element.dataset.path!, element);
  const scale = cssScale(container);
  for (const step of steps) {
    const element = elements.get(step.key);
    if (!element) continue;
    element.animate(
      [{ transform: `translate(${step.dx / scale}px, ${step.dy / scale}px)` }, { transform: "none" }],
      { ...timing, id: ENTRY_REFLOW_ANIMATION },
    );
  }
}

/** Viewport pixels per CSS pixel (root zoom). */
function cssScale(element: HTMLElement): number {
  const width = parseFloat(getComputedStyle(element).width);
  const rect = element.getBoundingClientRect().width;
  return width > 0 && rect > 0 ? rect / width : 1;
}

/** CSS px a held pane frame extends beyond its final bounds (0 when settled). */
export function contentHold(element: Element): number {
  const value = parseFloat(getComputedStyle(element).getPropertyValue(PANE_CONTENT_HOLD_X));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** A reflow animates while its pane's frame is held for a reveal, or while an
 * earlier reflow is still gliding (so a second reflow continues from it). */
export function reflowTiming(container: HTMLElement, timing: ReflowTiming): ReflowTiming | undefined {
  return contentHold(container) > 0 || reflowAnimations(container).length > 0 ? timing : undefined;
}

export const pauseEntryReflows = (root: Element) => { for (const a of reflowAnimations(root)) a.pause(); };
export const resumeEntryReflows = (root: Element) => {
  for (const a of reflowAnimations(root)) if (a.playState === "paused") a.play();
};
export const finishEntryReflows = (root: Element) => { for (const a of reflowAnimations(root)) a.cancel(); };
