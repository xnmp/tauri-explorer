/**
 * Site demo: on a touch screen a single tap on a file or folder opens it, as
 * a double-click does with a mouse. A phone cannot double-click (a double tap
 * zooms or is swallowed), so the marketing site's phone layout turns this on
 * through the bridge (`setTouchLayout`); the ordinary app never loads it.
 *
 * A pure state machine over pointer inputs. A press is a tap when it is a
 * touch or pen press of the primary pointer that lifts within TAP_MAX_MS and
 * travels less than TAP_SLOP_PX: a scroll (which cancels the pointer or moves
 * it), a long press (the context menu) and a mouse click are not taps.
 */

export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 500;

export type TapPointer = "mouse" | "touch" | "pen" | string;

export interface TapPoint {
  x: number;
  y: number;
  /** Milliseconds, any monotonic clock (`event.timeStamp`). */
  t: number;
}

export type TapState =
  | { kind: "idle" }
  | { kind: "pressed"; pointerId: number; at: TapPoint };

export type TapInput =
  | { type: "down"; pointerId: number; pointerType: TapPointer; isPrimary: boolean; button: number; at: TapPoint }
  | { type: "move"; pointerId: number; at: TapPoint }
  | { type: "up"; pointerId: number; at: TapPoint }
  | { type: "cancel"; pointerId: number };

export interface TapStep {
  state: TapState;
  /** True on the step that completes a tap. */
  tap: boolean;
}

export const TAP_IDLE: TapState = { kind: "idle" };

const finite = (p: TapPoint): boolean => [p.x, p.y, p.t].every((v) => typeof v === "number" && Number.isFinite(v));
const stay = (state: TapState): TapStep => ({ state, tap: false });
const travelled = (a: TapPoint, b: TapPoint): number => Math.hypot(b.x - a.x, b.y - a.y);

export function stepTap(state: TapState, input: TapInput): TapStep {
  if (state.kind === "idle") {
    if (input.type !== "down") return stay(state);
    const touchLike = input.pointerType === "touch" || input.pointerType === "pen";
    if (!touchLike || !input.isPrimary || input.button !== 0 || !finite(input.at)) return stay(state);
    return stay({ kind: "pressed", pointerId: input.pointerId, at: { ...input.at } });
  }
  if (input.type === "down") {
    // A second finger: whatever this is (a pinch), it is not a tap.
    return stay(TAP_IDLE);
  }
  if (input.pointerId !== state.pointerId) return stay(state);
  switch (input.type) {
    case "cancel":
      return stay(TAP_IDLE);
    case "move":
      if (!finite(input.at) || travelled(state.at, input.at) >= TAP_SLOP_PX) return stay(TAP_IDLE);
      return stay(state);
    case "up": {
      if (!finite(input.at)) return stay(TAP_IDLE);
      const quick = input.at.t - state.at.t <= TAP_MAX_MS;
      const still = travelled(state.at, input.at) < TAP_SLOP_PX;
      return { state: TAP_IDLE, tap: quick && still };
    }
  }
}

/**
 * Was this tap on something that has its own meaning inside a row (a peek
 * caret, a rename box, a checkbox, a link)? Those keep their own behaviour;
 * only the row itself opens.
 */
export const TAP_OWN_CONTROLS = "button, input, textarea, select, a[href], [contenteditable=''], [contenteditable='true'], [role='button'], [role='checkbox']";
