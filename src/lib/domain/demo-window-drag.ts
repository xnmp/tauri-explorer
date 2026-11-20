/**
 * Site demo: a press on the title bar's drag region becomes a window drag the
 * host page performs (bridge event `window-drag`). The demo has no window of
 * its own, so where a native window calls `startDragging()` the app reports
 * the gesture and the host moves its stand-in window.
 *
 * A pure state machine over pointer inputs. A press only becomes a drag once
 * the pointer has travelled DRAG_THRESHOLD_PX, so a click or a double-click
 * (which maximizes, through the ordinary `window-control` path) never moves
 * the window. Coordinates are screen coordinates: the frame itself moves
 * under the pointer while the host follows it, so frame-relative positions
 * would feed the window's own motion back into the gesture. The frame-relative
 * point is reported as well, so a host can place the pointer on its page.
 */

export const DRAG_THRESHOLD_PX = 4;

export interface DragPoint {
  screenX: number;
  screenY: number;
  /** In the frame's viewport. */
  clientX: number;
  clientY: number;
}

export type WindowDragPhase = "start" | "move" | "end";

/** The `window-drag` event's data. */
export interface WindowDragEvent extends DragPoint {
  phase: WindowDragPhase;
}

export type WindowDragState =
  | { kind: "idle" }
  | { kind: "pressed"; pointerId: number; at: DragPoint }
  | { kind: "dragging"; pointerId: number; last: DragPoint };

export type WindowDragInput =
  | { type: "down"; pointerId: number; button: number; isPrimary: boolean; onDragRegion: boolean; at: DragPoint }
  | { type: "move"; pointerId: number; at: DragPoint }
  /** `cancel`: the browser took the pointer (pointercancel, lost capture); its point may be meaningless. */
  | { type: "up" | "cancel"; pointerId: number; at: DragPoint };

export interface WindowDragStep {
  state: WindowDragState;
  events: WindowDragEvent[];
  /** True on the step a drag begins: capture the pointer so the moves keep coming as the frame moves away under it. */
  capture: boolean;
}

export const IDLE: WindowDragState = { kind: "idle" };

const finite = (p: DragPoint): boolean =>
  [p.screenX, p.screenY, p.clientX, p.clientY].every((v) => typeof v === "number" && Number.isFinite(v));

const point = ({ screenX, screenY, clientX, clientY }: DragPoint): DragPoint => ({ screenX, screenY, clientX, clientY });
const event = (phase: WindowDragPhase, at: DragPoint): WindowDragEvent => ({ phase, ...point(at) });
const stay = (state: WindowDragState): WindowDragStep => ({ state, events: [], capture: false });

export function stepWindowDrag(state: WindowDragState, input: WindowDragInput): WindowDragStep {
  switch (state.kind) {
    case "idle": {
      if (input.type !== "down") return stay(state);
      if (!input.onDragRegion || !input.isPrimary || input.button !== 0 || !finite(input.at)) return stay(state);
      return stay({ kind: "pressed", pointerId: input.pointerId, at: point(input.at) });
    }
    case "pressed": {
      if (input.pointerId !== state.pointerId) return stay(state);
      if (input.type === "up" || input.type === "cancel") return stay(IDLE);
      if (input.type !== "move" || !finite(input.at)) return stay(state);
      const dx = input.at.screenX - state.at.screenX;
      const dy = input.at.screenY - state.at.screenY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return stay(state);
      return {
        state: { kind: "dragging", pointerId: state.pointerId, last: point(input.at) },
        // The press point anchors the drag, so the window moves by exactly the pointer's travel.
        events: [event("start", state.at), event("move", input.at)],
        capture: true,
      };
    }
    case "dragging": {
      if (input.pointerId !== state.pointerId) return stay(state);
      if (input.type === "move") {
        if (!finite(input.at)) return stay(state);
        return { state: { ...state, last: point(input.at) }, events: [event("move", input.at)], capture: false };
      }
      if (input.type === "up") {
        const at = finite(input.at) ? input.at : state.last;
        return { state: IDLE, events: [event("end", at)], capture: false };
      }
      if (input.type === "cancel") return { state: IDLE, events: [event("end", state.last)], capture: false };
      return stay(state);
    }
  }
}
