import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD_PX,
  IDLE,
  stepWindowDrag,
  type DragPoint,
  type WindowDragEvent,
  type WindowDragInput,
  type WindowDragState,
} from "$lib/domain/demo-window-drag";
import { onWindowDragRegion } from "$lib/state/site-demo-window-drag";

const at = (screenX: number, screenY: number, clientX = screenX - 100, clientY = screenY - 50): DragPoint => ({ screenX, screenY, clientX, clientY });
const down = (p: DragPoint, more: Partial<Extract<WindowDragInput, { type: "down" }>> = {}): WindowDragInput =>
  ({ type: "down", pointerId: 1, button: 0, isPrimary: true, onDragRegion: true, at: p, ...more });
const move = (p: DragPoint, pointerId = 1): WindowDragInput => ({ type: "move", pointerId, at: p });
const up = (p: DragPoint, pointerId = 1): WindowDragInput => ({ type: "up", pointerId, at: p });
const cancel = (p: DragPoint, pointerId = 1): WindowDragInput => ({ type: "cancel", pointerId, at: p });

/** Feed inputs from idle; collect every event and whether a step asked to capture. */
function run(inputs: WindowDragInput[]): { state: WindowDragState; events: WindowDragEvent[]; captures: number } {
  let state = IDLE;
  const events: WindowDragEvent[] = [];
  let captures = 0;
  for (const input of inputs) {
    const step = stepWindowDrag(state, input);
    state = step.state;
    events.push(...step.events);
    if (step.capture) captures++;
  }
  return { state, events, captures };
}

describe("window drag gesture (site demo)", () => {
  it("reports a drag as start at the press point, each move, then end where it was released", () => {
    const { state, events, captures } = run([down(at(200, 80)), move(at(210, 84)), move(at(260, 120)), up(at(262, 121))]);
    expect(events.map((e) => [e.phase, e.screenX, e.screenY])).toEqual([
      ["start", 200, 80],
      ["move", 210, 84],
      ["move", 260, 120],
      ["end", 262, 121],
    ]);
    expect(events[0]).toMatchObject({ clientX: 100, clientY: 30 });
    expect(captures).toBe(1);
    expect(state).toEqual(IDLE);
  });

  it("a click or a double-click without travel never moves the window", () => {
    const wobble = DRAG_THRESHOLD_PX - 1;
    const { events, captures } = run([
      down(at(200, 80)), move(at(200 + wobble, 80)), up(at(200 + wobble, 80)),
      down(at(200, 80)), up(at(200, 80)),
    ]);
    expect(events).toEqual([]);
    expect(captures).toBe(0);
  });

  it("starts once the pointer has travelled the threshold in any direction", () => {
    const d = DRAG_THRESHOLD_PX / Math.SQRT2 + 0.01;
    expect(run([down(at(0, 0)), move(at(-d, -d))]).events.map((e) => e.phase)).toEqual(["start", "move"]);
  });

  it("ignores presses off the drag region, secondary buttons and non-primary pointers", () => {
    for (const press of [down(at(0, 0), { onDragRegion: false }), down(at(0, 0), { button: 2 }), down(at(0, 0), { isPrimary: false })]) {
      expect(run([press, move(at(50, 50)), up(at(50, 50))]).events).toEqual([]);
    }
  });

  it("follows only the pointer that pressed (a second finger does nothing)", () => {
    const { events } = run([down(at(0, 0)), down(at(300, 300), { pointerId: 2 }), move(at(40, 0), 2), move(at(20, 0)), up(at(40, 0), 2), up(at(20, 0))]);
    expect(events.map((e) => [e.phase, e.screenX])).toEqual([["start", 0], ["move", 20], ["end", 20]]);
  });

  it("a cancelled drag still ends, at the last point the window followed", () => {
    const { events, state } = run([down(at(0, 0)), move(at(30, 10)), cancel(at(0, 0))]);
    expect(events.at(-1)).toMatchObject({ phase: "end", screenX: 30, screenY: 10 });
    expect(state).toEqual(IDLE);
  });

  it("a cancelled press is forgotten without an event", () => {
    expect(run([down(at(0, 0)), cancel(at(0, 0)), move(at(80, 0))]).events).toEqual([]);
  });

  it("drops malformed coordinates instead of moving the window to them", () => {
    const bad = { screenX: Number.NaN, screenY: 0, clientX: 0, clientY: 0 };
    expect(run([down(bad), move(at(80, 0))]).events).toEqual([]);
    const { events } = run([down(at(0, 0)), move(at(20, 0)), move(bad), move({ ...at(30, 0), screenY: Infinity }), up(bad)]);
    expect(events.map((e) => [e.phase, e.screenX])).toEqual([["start", 0], ["move", 20], ["end", 20]]);
  });

  it("handles extreme coordinates as ordinary numbers", () => {
    const { events } = run([down(at(-1e7, -1e7)), move(at(1e7, 1e7)), up(at(1e7, 1e7))]);
    expect(events.map((e) => e.phase)).toEqual(["start", "move", "end"]);
  });

  it("reports plain data, not the pointer event it was read from", () => {
    const source = { ...at(5, 5), pointerType: "touch", target: {} } as unknown as DragPoint;
    const { events } = run([down(at(0, 0)), move(source)]);
    expect(Object.keys(events[1]).sort()).toEqual(["clientX", "clientY", "phase", "screenX", "screenY"]);
  });
});

describe("the title bar's drag region", () => {
  type Fake = { closest(selector: string): Fake | null };
  const el = (matches: string[]): Fake => ({ closest: (selector) => (matches.some((m) => selector.includes(m)) ? el(matches) : null) });

  it("is the title bar's empty space", () => {
    expect(onWindowDragRegion(el(['data-region="titlebar"']))).toBe(true);
  });

  it("excludes the bar's tabs, buttons and inputs, as the native title bar does", () => {
    expect(onWindowDragRegion(el(['data-region="titlebar"', "button"]))).toBe(false);
    expect(onWindowDragRegion(el(['data-region="titlebar"', ".tab-scroll-group"]))).toBe(false);
  });

  it("excludes everything outside the title bar, and non-elements", () => {
    expect(onWindowDragRegion(el([]))).toBe(false);
    expect(onWindowDragRegion(null)).toBe(false);
    expect(onWindowDragRegion({})).toBe(false);
  });
});
