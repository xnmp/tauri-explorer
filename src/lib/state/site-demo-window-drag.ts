/**
 * Site demo: pointer drags on the title bar's drag region go to the host page
 * as `window-drag { phase, screenX, screenY, clientX, clientY }` events
 * (decisions in `domain/demo-window-drag.ts`). The drag region is what a
 * native window drags by (`TitleBar.svelte`, `titlebar.startsWindowDrag`): the
 * bar's empty space, never its tabs, buttons or inputs. A double-click there
 * maximizes through `window-control`, as the native title bar does.
 *
 * Only `startSiteDemoBridge` installs this, so ordinary builds never load it.
 */
import { startsWindowDrag } from "$lib/domain/titlebar";
import { IDLE, stepWindowDrag, type WindowDragInput, type WindowDragState } from "$lib/domain/demo-window-drag";

const TITLEBAR = '[data-region="titlebar"]';

type Closest = Pick<Element, "closest">;
const asElement = (target: unknown): Closest | null =>
  target && typeof (target as Closest).closest === "function" ? (target as Closest) : null;

/** Is this press on the title bar's drag region? (Text nodes and non-elements are not.) */
export function onWindowDragRegion(target: unknown): boolean {
  const el = asElement(target);
  return Boolean(el?.closest(TITLEBAR)) && startsWindowDrag(el as Element);
}

export function forwardWindowDrags(doc: Document, emit: (event: string, data: unknown) => void): void {
  // Touch: without this the browser pans on a title-bar swipe and cancels the pointer. The tab strip's
  // own scroller keeps its panning (touch-action stops at the nearest scrolling ancestor).
  const style = doc.createElement("style");
  style.textContent = `${TITLEBAR} { touch-action: none; }`;
  doc.head.append(style);

  let state: WindowDragState = IDLE;
  // The title bar pressed, which takes the pointer once the press becomes a drag.
  let bar: Element | null = null;
  let captor: Element | null = null;
  const feed = (input: WindowDragInput, target: EventTarget | null) => {
    const pressing = state.kind === "idle";
    const step = stepWindowDrag(state, input);
    state = step.state;
    if (pressing && step.state.kind === "pressed") bar = (asElement(target) as Element | null)?.closest(TITLEBAR) ?? null;
    if (step.capture && bar) {
      captor = bar;
      try { captor.setPointerCapture(input.pointerId); } catch { /* the pointer is already gone: its end follows */ }
    }
    for (const data of step.events) emit("window-drag", data);
    if (state.kind === "idle") bar = captor = null;
  };

  doc.addEventListener("pointerdown", (e) => {
    feed({ type: "down", pointerId: e.pointerId, button: e.button, isPrimary: e.isPrimary, onDragRegion: onWindowDragRegion(e.target), at: e }, e.target);
  }, true);
  doc.addEventListener("pointermove", (e) => feed({ type: "move", pointerId: e.pointerId, at: e }, e.target), true);
  doc.addEventListener("pointerup", (e) => feed({ type: "up", pointerId: e.pointerId, at: e }, e.target), true);
  doc.addEventListener("pointercancel", (e) => feed({ type: "cancel", pointerId: e.pointerId, at: e }, e.target), true);
  // Capture lost without an up (the element left the document, say): the gesture ends where it was.
  doc.addEventListener("lostpointercapture", (e) => {
    if (e.target === captor) feed({ type: "cancel", pointerId: e.pointerId, at: e }, e.target);
  }, true);
}
