/**
 * Site demo: the host's touch layout (bridge request `setTouchLayout(true)`,
 * for its phone layout). Three things change while it is on:
 *
 * - a single tap on a file or folder row opens it (decisions in
 *   `domain/demo-tap-open.ts`);
 * - text fields are at least 16px, so a phone never zooms the page in when
 *   one takes focus (iOS zooms the whole page for a smaller field, even one
 *   inside this frame). Pinch zoom stays the visitor's;
 * - file rows draw no keyboard-cursor ring (there is no keyboard to move it).
 *
 * For the tap, the row's own click still runs first, so it selects as usual;
 * the open then goes through the row's ordinary double-click path, the same
 * one a mouse uses, so folders navigate and files reach `open-external`.
 *
 * Only `startSiteDemoBridge` installs this, so ordinary builds never load it.
 */
import { stepTap, TAP_IDLE, TAP_OWN_CONTROLS, type TapInput, type TapState } from "$lib/domain/demo-tap-open";

/** The rows that open on a double-click: every view's file and folder rows (Details, List, Tiles). */
const ROW = '.entry-item[data-region="row"][data-path]';

type Closest = Pick<Element, "closest">;
const asElement = (target: unknown): Closest | null =>
  target && typeof (target as Closest).closest === "function" ? (target as Closest) : null;

/** The row a tap on `target` opens: a row itself, not a control inside it; null elsewhere. */
export function tapOpenRow(target: unknown): Element | null {
  const el = asElement(target);
  if (!el || el.closest(TAP_OWN_CONTROLS)) return null;
  return el.closest(ROW);
}

export interface TouchLayout {
  set(on: boolean): void;
  readonly on: boolean;
}

/** The attribute the touch layout's styles key on, on the document element. */
const TOUCH_ATTR = "data-site-demo-touch";
const TOUCH_CSS = [
  `:root[${TOUCH_ATTR}] :is(input, textarea, select) { font-size: max(16px, 1em) !important; }`,
  // The app moves its keyboard cursor onto a row as it boots and after some changes; with no keyboard the ring
  // would only look like a stray selection. The selection itself still shows.
  `:root[${TOUCH_ATTR}] .entry-item:focus-visible { outline: none !important; }`,
].join("\n");

export function installTouchLayout(doc: Document): TouchLayout {
  let on = false;
  const style = doc.createElement("style");
  style.textContent = TOUCH_CSS;
  doc.head.append(style);
  let state: TapState = TAP_IDLE;
  // The row of the tap that just completed, which the click that follows it opens.
  let tapped: { row: Element; t: number } | null = null;
  const feed = (input: TapInput) => {
    const step = stepTap(state, input);
    state = step.state;
    return step.tap;
  };
  const at = (e: PointerEvent) => ({ x: e.clientX, y: e.clientY, t: e.timeStamp });

  doc.addEventListener("pointerdown", (e) => {
    if (!on) return;
    tapped = null;
    feed({ type: "down", pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary, button: e.button, at: at(e) });
  }, true);
  doc.addEventListener("pointermove", (e) => { if (on) feed({ type: "move", pointerId: e.pointerId, at: at(e) }); }, true);
  doc.addEventListener("pointercancel", (e) => { if (on) feed({ type: "cancel", pointerId: e.pointerId }); }, true);
  doc.addEventListener("pointerup", (e) => {
    if (!on) return;
    const row = feed({ type: "up", pointerId: e.pointerId, at: at(e) }) ? tapOpenRow(e.target) : null;
    tapped = row ? { row, t: e.timeStamp } : null;
  }, true);
  // Bubble phase on the document: after the app's own (delegated) click handler has selected the row.
  doc.addEventListener("click", (e) => {
    const t = tapped;
    tapped = null;
    if (!on || !t || !t.row.isConnected || e.timeStamp - t.t > 800 || tapOpenRow(e.target) !== t.row) return;
    t.row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2, view: doc.defaultView }));
  });

  return {
    set(next: boolean) {
      on = next; state = TAP_IDLE; tapped = null;
      doc.documentElement.toggleAttribute(TOUCH_ATTR, on);
    },
    get on() { return on; },
  };
}
