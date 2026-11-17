/**
 * DOM side of the window tab strip's motion and measurement (#1734): the
 * slide transition, the glide that follows a revealing scroll, the title
 * fade's fit check, and the room the strip may take. The geometry they apply
 * lives in `domain/tab-strip.ts` and `domain/tab-slide.ts`; `WindowTabBar`
 * owns when they run.
 */
import { cubicOut } from "svelte/easing";
import { TAB_BLEED } from "$lib/domain/tab-strip";
import { TAB_STRIP_PADDING } from "$lib/domain/tab-seam";
import { tabSlideCss } from "$lib/domain/tab-slide";

/** The selected state Svelte last rendered on a leaving tab, kept while
 *  `tabSlide` shows it unselected. */
const leaving = new WeakMap<Element, { active: boolean; selected: string | null }>();

function showUnselected(node: Element): void {
  if (!leaving.has(node)) leaving.set(node, { active: node.classList.contains("active"), selected: node.getAttribute("aria-selected") });
  node.classList.remove("active");
  node.setAttribute("aria-selected", "false");
}

function restoreRendered(node: Element): void {
  const rendered = leaving.get(node);
  if (!rendered) return;
  leaving.delete(node);
  node.classList.toggle("active", rendered.active);
  if (rendered.selected === null) node.removeAttribute("aria-selected");
  else node.setAttribute("aria-selected", rendered.selected);
}

/** Tab enter/exit: animate --tab-slide, which sizes the tab from the live
 *  --tab-width, never clipping the fillets (domain/tab-slide.ts).
 *
 *  A closing tab is no longer the selected one: its neighbour took over when
 *  it was removed, and Svelte no longer updates the leaving node, so it must
 *  not keep looking (or being found as) the active tab while it slides out.
 *  (Svelte makes it inert, and restores that itself.) If the same tab
 *  returns before its slide ends, Svelte reverses the outro, starts the
 *  intro, and resumes updating the node by comparing against what it last
 *  rendered, so the intro first puts that back (#1744 review).
 *
 *  Svelte computes an outro's options once per node and reuses them for a
 *  later outro, but calls a deferred config (a function, as `crossfade`
 *  returns) at the start of every one, before the next frame: the leaving
 *  state is applied there. An intro's options are computed again after
 *  every outro. */
export function tabSlide(node: Element, { duration, sized }: { duration: number; sized: boolean }) {
  const config = { duration, easing: cubicOut, css: (t: number) => tabSlideCss(t, "var(--tab-width)", TAB_BLEED, sized) };
  if (!sized) {
    restoreRendered(node);
    return config;
  }
  return () => {
    showUnselected(node);
    return config;
  };
}

/**
 * A reveal that follows a sliding tab glides with it: the tab list is
 * shifted back by the distance just scrolled, so nothing moves on this
 * frame, and the shift eases out over the slide's duration and curve
 * (window-tab-bar.css). Crossing into overflow scrolled every tab sideways
 * in one frame.
 */
export function glideTabList(list: HTMLElement, distance: number): void {
  // A glide still under way continues from where it is.
  const current = list.classList.contains("shifted") ? parseFloat(getComputedStyle(list).getPropertyValue("--tab-list-shift")) || 0 : 0;
  list.classList.remove("glide");
  list.classList.add("shifted");
  list.style.setProperty("--tab-list-shift", String(distance + current));
  void getComputedStyle(list).getPropertyValue("--tab-list-shift");
  list.classList.add("glide");
  list.style.setProperty("--tab-list-shift", "0");
  const settle = (event: TransitionEvent) => {
    if (event.target !== list || event.propertyName !== "--tab-list-shift") return;
    list.removeEventListener("transitionend", settle);
    list.removeEventListener("transitioncancel", settle);
    if (list.style.getPropertyValue("--tab-list-shift") === "0") list.classList.remove("shifted", "glide");
  };
  list.addEventListener("transitionend", settle);
  list.addEventListener("transitioncancel", settle);
}

/**
 * A title fades out at its right edge only when it does not fit: a title
 * that fits shows every letter at full strength. One observer follows every
 * title as tabs slide and the strip re-lays out; its callback only toggles a
 * class, which changes no size.
 */
export function createTitleFit() {
  // Its parts (repo, folder) shrink and clip inside it, so each must fit too.
  const fits = (node: Element) => node.scrollWidth <= node.clientWidth;
  const mark = (node: Element) => node.classList.toggle("fits", fits(node) && [...node.children].every(fits));
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
    for (const { target } of entries) mark(target);
  });
  return {
    /** Svelte action. The text changes without resizing the box when a tab
     *  navigates, so the title is checked again whenever it changes. */
    action(node: HTMLElement, _text: string) {
      observer?.observe(node);
      return { update: () => mark(node), destroy: () => observer?.unobserve(node) };
    },
    dispose: () => observer?.disconnect(),
  };
}

/**
 * The room the tabs may take as if the strip started at the window edge:
 * the title bar's room box (`data-tab-room-box`, the strip plus its flexible
 * spacer `data-tab-room`) less the spacer's minimum, the strip's edge
 * padding and its buttons. Observe the box, never the strip or the spacer:
 * the strip start and the tabs move space between those two without resizing
 * the box, so writing them never re-triggers that observer in the same frame,
 * which WebKit reports as a ResizeObserver loop. Without a spacer the group
 * has an explicit width, which is the room.
 */
export function tabRoomAtFloor(tabArea: HTMLElement, group: HTMLElement): { room: number; box: HTMLElement | null } {
  const spacer = tabArea.parentElement?.querySelector<HTMLElement>(":scope > [data-tab-room]") ?? null;
  const box = spacer?.parentElement ?? null;
  if (!spacer || !box) return { room: group.clientWidth, box: null };
  const spacerMin = parseFloat(getComputedStyle(spacer).minWidth) || 0;
  const padding = parseFloat(getComputedStyle(tabArea).paddingLeft) || 0;
  const buttons = Math.max(0, tabArea.offsetWidth - padding - group.offsetWidth);
  return { room: box.clientWidth - spacerMin - TAB_STRIP_PADDING - buttons, box };
}
