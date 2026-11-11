/**
 * Window-tab drag lifecycle (#1642, Chrome-style detach #176).
 *
 * A press becomes a drag past the shared threshold; a drag that leaves the
 * strip far enough detaches into a window, which then follows the pointer
 * until release. `S` identifies one press-to-release session: a result that
 * arrives for another session (a detach finishing after release, Escape or a
 * new press) changes nothing. The component owns every side effect and runs
 * the one each transition names.
 */
import { pastDragThreshold, type Point } from "./pointer-drag";

/** How far below its press the pointer must travel, outside the strip, to detach. */
const DETACH_THRESHOLD_PX = 36;

export type TabDrag<S, W> =
  | { readonly kind: "idle" }
  /** Pressed, not yet past the drag threshold: a release is a click. */
  | { readonly kind: "pressed" | "dragging" | "detaching"; readonly session: S; readonly tabId: string; readonly start: Point }
  | { readonly kind: "detached"; readonly session: S; readonly tabId: string; readonly start: Point; readonly window: W };

export type TabDragEvent<S, W> =
  | { readonly type: "press"; readonly session: S; readonly tabId: string; readonly at: Point }
  /** `outsideStrip`: detaching is supported here and the pointer is off the tab strip. */
  | { readonly type: "move"; readonly at: Point; readonly outsideStrip: boolean }
  /** A detach finished: the new window, or null when none was created. */
  | { readonly type: "detached"; readonly session: S; readonly window: W | null }
  | { readonly type: "release" }
  | { readonly type: "cancel" };

/**
 * What the component does for a transition:
 * - `activate`: the press became a drag; acquire the transfer and ghost, or cancel.
 * - `hover`: move the ghost and drop indicator.
 * - `detach`: open a window for the tab at the pointer.
 * - `follow`: move the detached window to the pointer.
 * - `click` / `drop` / `focus`: release of a press, a drag, or a detach.
 * - `end`: the session ended without a drop (Escape, failure, or a detach that made no window).
 */
export type TabDragEffect = "none" | "activate" | "hover" | "detach" | "follow" | "click" | "drop" | "focus" | "end";

export const TAB_DRAG_IDLE: TabDrag<never, never> = Object.freeze({ kind: "idle" });

export function stepTabDrag<S, W>(
  drag: TabDrag<S, W>,
  event: TabDragEvent<S, W>,
): { drag: TabDrag<S, W>; effect: TabDragEffect } {
  const to = (next: TabDrag<S, W>, effect: TabDragEffect) => ({ drag: next, effect });
  const stay = to(drag, "none");
  if (event.type === "press") {
    return to({ kind: "pressed", session: event.session, tabId: event.tabId, start: event.at }, "none");
  }
  if (drag.kind === "idle") return stay;
  switch (event.type) {
    case "move":
      if (drag.kind === "pressed") {
        return pastDragThreshold(drag.start, event.at) ? to({ ...drag, kind: "dragging" }, "activate") : stay;
      }
      if (drag.kind === "detached") return to(drag, "follow");
      if (drag.kind === "detaching") return stay;
      return event.outsideStrip && Math.abs(event.at.y - drag.start.y) > DETACH_THRESHOLD_PX
        ? to({ ...drag, kind: "detaching" }, "detach")
        : to(drag, "hover");
    case "detached":
      if (drag.kind !== "detaching" || drag.session !== event.session) return stay;
      return event.window === null ? to(TAB_DRAG_IDLE, "end") : to({ ...drag, kind: "detached", window: event.window }, "none");
    case "release":
      return to(TAB_DRAG_IDLE, drag.kind === "pressed" ? "click" : drag.kind === "dragging" ? "drop" : "focus");
    case "cancel":
      return to(TAB_DRAG_IDLE, "end");
  }
}
