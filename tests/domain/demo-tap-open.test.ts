import { describe, expect, it } from "vitest";
import { stepTap, TAP_IDLE, TAP_MAX_MS, TAP_SLOP_PX, type TapInput, type TapPoint } from "$lib/domain/demo-tap-open";

const at = (x: number, y: number, t: number): TapPoint => ({ x, y, t });
const down = (p: TapPoint, more: Partial<Extract<TapInput, { type: "down" }>> = {}): TapInput =>
  ({ type: "down", pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, at: p, ...more });
const move = (p: TapPoint, pointerId = 1): TapInput => ({ type: "move", pointerId, at: p });
const up = (p: TapPoint, pointerId = 1): TapInput => ({ type: "up", pointerId, at: p });

/** How many taps a sequence of inputs completes. */
function taps(inputs: TapInput[]): number {
  let state = TAP_IDLE, n = 0;
  for (const input of inputs) { const step = stepTap(state, input); state = step.state; if (step.tap) n++; }
  return n;
}

describe("a tap opens", () => {
  it("counts a quick, still touch press", () => {
    expect(taps([down(at(10, 10, 0)), up(at(12, 11, 120))])).toBe(1);
  });

  it("counts a pen press as well", () => {
    expect(taps([down(at(10, 10, 0), { pointerType: "pen" }), up(at(10, 10, 80))])).toBe(1);
  });

  it("allows a finger's small wobble under the slop", () => {
    expect(taps([down(at(0, 0, 0)), move(at(TAP_SLOP_PX - 1, 0, 40)), up(at(TAP_SLOP_PX - 1, 0, 90))])).toBe(1);
  });
});

describe("what is not a tap", () => {
  it("ignores the mouse: a click selects, a double-click opens, as in the app", () => {
    expect(taps([down(at(0, 0, 0), { pointerType: "mouse" }), up(at(0, 0, 50))])).toBe(0);
  });

  it("is not a scroll: travel past the slop ends the press, even if it comes back", () => {
    expect(taps([down(at(0, 0, 0)), move(at(0, TAP_SLOP_PX, 30)), move(at(0, 0, 60)), up(at(0, 0, 90))])).toBe(0);
  });

  it("is not a scroll the browser took (pointercancel)", () => {
    expect(taps([down(at(0, 0, 0)), { type: "cancel", pointerId: 1 }, up(at(0, 0, 60))])).toBe(0);
  });

  it("is not a long press (that opens the context menu)", () => {
    expect(taps([down(at(0, 0, 0)), up(at(0, 0, TAP_MAX_MS + 1))])).toBe(0);
    expect(taps([down(at(0, 0, 0)), up(at(0, 0, TAP_MAX_MS))])).toBe(1);
  });

  it("is not a pinch: a second finger ends it", () => {
    expect(taps([down(at(0, 0, 0)), down(at(50, 50, 10), { pointerId: 2, isPrimary: false }), up(at(0, 0, 60))])).toBe(0);
  });

  it("ignores another pointer's moves and lifts", () => {
    expect(taps([down(at(0, 0, 0)), move(at(80, 80, 10), 7), up(at(80, 80, 20), 7), up(at(0, 0, 40))])).toBe(1);
  });

  it("ignores a secondary button and a non-primary pointer", () => {
    expect(taps([down(at(0, 0, 0), { button: 2 }), up(at(0, 0, 30))])).toBe(0);
    expect(taps([down(at(0, 0, 0), { isPrimary: false }), up(at(0, 0, 30))])).toBe(0);
  });

  it("never counts malformed coordinates", () => {
    expect(taps([down(at(Number.NaN, 0, 0)), up(at(0, 0, 30))])).toBe(0);
    expect(taps([down(at(0, 0, 0)), up(at(0, Number.POSITIVE_INFINITY, 30))])).toBe(0);
    expect(taps([down(at(0, 0, 0)), move(at(0, Number.NaN, 10)), up(at(0, 0, 30))])).toBe(0);
  });

  it("does not count a lift with no press, or one press twice", () => {
    expect(taps([up(at(0, 0, 10))])).toBe(0);
    expect(taps([down(at(0, 0, 0)), up(at(0, 0, 30)), up(at(0, 0, 40))])).toBe(1);
  });
});

describe("which row a tap opens", async () => {
  const { tapOpenRow } = await import("$lib/state/site-demo-tap-open");
  const { TAP_OWN_CONTROLS } = await import("$lib/domain/demo-tap-open");
  const ROW = '.entry-item[data-region="row"][data-path]';
  const row = { name: "row" };
  // a stand-in element: `closest` answers for the selectors it lies inside
  const inside = (hits: Record<string, unknown>) => ({ closest: (selector: string) => (hits[selector] ?? null) });

  it("opens the row a tap lands on", () => {
    expect(tapOpenRow(inside({ [ROW]: row }))).toBe(row);
  });

  it("leaves a control inside the row to its own behaviour (a peek caret, the rename box)", () => {
    expect(tapOpenRow(inside({ [ROW]: row, [TAP_OWN_CONTROLS]: { name: "caret" } }))).toBeNull();
  });

  it("opens nothing outside a row, or for a target that is not an element", () => {
    expect(tapOpenRow(inside({}))).toBeNull();
    expect(tapOpenRow(null)).toBeNull();
    expect(tapOpenRow({ nodeType: 3 })).toBeNull();
  });
});
