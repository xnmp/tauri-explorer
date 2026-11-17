/**
 * How the window tab strip follows a change to its tabs (#1734). Pure
 * decisions; `composables/tab-strip-motion.svelte.ts` schedules them.
 *
 * The strip's total width moves one way only, or the new-tab button dips.
 * A sliding tab animates from the frame after its insertion or removal
 * (Svelte's placeholder frame), so the strip lays out a new count a frame
 * late too, and the other tabs ease over the slide's own duration and curve.
 * Switching tabs swaps the active and inactive widths with one ease, at once.
 */
import { TAB_SLIDE_IN_MS, TAB_SLIDE_OUT_MS } from "./tab-slide";

/** The tabs the strip lays out. */
export interface StripTabs {
  readonly count: number;
  readonly activeId: string | null;
  readonly ids: ReadonlySet<string>;
}

export function stripTabsOf(tabs: readonly { readonly id: string }[], activeId: string | null): StripTabs {
  return { count: tabs.length, activeId, ids: new Set(tabs.map((tab) => tab.id)) };
}

/** What a change from `previousCount` tabs to `next` does to the strip. */
export interface StripStep {
  /** The other tabs' width ease: a closing slide's, else an opening one's. */
  readonly widthEaseMs: number;
  /** A tab slides in or out: the strip adopts `next` a frame later, its
   *  start eases with the slide, and a reveal glides with it. Otherwise it
   *  adopts `next` at once and its start keeps its ease. */
  readonly slides: boolean;
}

export function stripStep(previousCount: number, next: StripTabs): StripStep {
  return {
    widthEaseMs: next.count < previousCount ? TAB_SLIDE_OUT_MS : TAB_SLIDE_IN_MS,
    slides: next.count !== previousCount,
  };
}

interface TabWidths {
  readonly activeWidth: number;
  readonly inactiveWidth: number;
}

/**
 * A tab's width. A tab the strip lays out takes its width there; a tab
 * sliding in (not laid out yet) grows to the width it will have once the
 * strip lays out the new count: growing towards a width that was itself
 * still easing there lagged the other tabs, and the strip dipped.
 */
export function stripTabWidth(
  id: string,
  strip: StripTabs,
  laidOut: TabWidths,
  activeId: string | null,
  entering: TabWidths,
): number {
  if (strip.ids.has(id)) return id === strip.activeId ? laidOut.activeWidth : laidOut.inactiveWidth;
  return id === activeId ? entering.activeWidth : entering.inactiveWidth;
}
