import { describe, expect, it } from "vitest";
import { pastDragThreshold } from "$lib/domain/pointer-drag";
import { stepTabDrag, TAB_DRAG_IDLE, type TabDrag, type TabDragEvent } from "$lib/domain/tab-drag";

function gesture() {
  const session = {};
  let drag: TabDrag<object, string> = TAB_DRAG_IDLE;
  const send = (event: TabDragEvent<object, string>) => {
    const result = stepTabDrag(drag, event);
    drag = result.drag;
    return result.effect;
  };
  const press = (identity = session) => send({ type: "press", session: identity, tabId: "a", at: { x: 10, y: 20 } });
  const move = (x: number, y: number, outsideStrip = false) => send({ type: "move", at: { x, y }, outsideStrip });
  press();
  return { session, send, press, move };
}

describe("tab drag effects", () => {
  it("releases a stationary or subthreshold press as a click", () => {
    const g = gesture();
    expect(g.move(12, 23)).toBe("none");
    expect(g.send({ type: "release" })).toBe("click");
    expect(g.send({ type: "release" })).toBe("none");
  });

  it("acquires a drag once at the five-pixel threshold, then hovers and drops", () => {
    const g = gesture();
    expect(g.move(13, 24)).toBe("activate");
    expect(g.move(14, 24)).toBe("hover");
    expect(g.send({ type: "release" })).toBe("drop");
    expect(g.move(20, 30)).toBe("none");
  });

  it.each([57, -17])("detaches once outside the strip at y=%s", (y) => {
    const g = gesture();
    g.move(15, 20);
    expect(g.move(15, y)).toBe("hover");
    expect(g.move(15, y, true)).toBe("detach");
    expect(g.move(20, y, true)).toBe("none");
    expect(g.send({ type: "detached", session: g.session, window: "child" })).toBe("none");
    expect(g.move(25, y)).toBe("follow");
    expect(g.send({ type: "release" })).toBe("focus");
    expect(g.move(30, y)).toBe("none");
  });

  it("does not detach at the vertical boundary or for horizontal-only travel", () => {
    const g = gesture();
    g.move(15, 20);
    expect(g.move(100, 20, true)).toBe("hover");
    expect(g.move(15, 56, true)).toBe("hover");
    expect(g.move(15, -16, true)).toBe("hover");
  });

  it("ends a failed detach without accepting a later success", () => {
    const g = gesture();
    g.move(15, 20);
    g.move(15, 60, true);
    expect(g.send({ type: "detached", session: g.session, window: null })).toBe("end");
    expect(g.send({ type: "detached", session: g.session, window: "child" })).toBe("none");
    expect(g.move(20, 60)).toBe("none");
  });

  it.each(["release", "cancel"] as const)("ignores detach settlement after %s", (type) => {
    const g = gesture();
    g.move(15, 20);
    g.move(15, 60, true);
    expect(g.send({ type })).toBe(type === "release" ? "focus" : "end");
    g.send({ type: "detached", session: g.session, window: "child" });
    expect(g.move(20, 60)).toBe("none");
  });

  it("a late result from an older gesture cannot settle a new detach", () => {
    const g = gesture();
    g.move(15, 20);
    g.move(15, 60, true);
    g.send({ type: "cancel" });
    const replacement = {};
    g.press(replacement);
    g.move(15, 20);
    g.move(15, 60, true);
    g.send({ type: "detached", session: g.session, window: "old" });
    expect(g.move(20, 60)).toBe("none");
    g.send({ type: "detached", session: replacement, window: "new" });
    expect(g.move(20, 60)).toBe("follow");
  });

  it("cancel stops a detached window from following or being focused", () => {
    const g = gesture();
    g.move(15, 20);
    g.move(15, 60, true);
    g.send({ type: "detached", session: g.session, window: "child" });
    expect(g.send({ type: "cancel" })).toBe("end");
    expect(g.move(20, 60)).toBe("none");
    expect(g.send({ type: "release" })).toBe("none");
  });
});

describe("shared pointer drag threshold", () => {
  it.each([
    [0, 0, false], [4, 0, false], [0, -4.99, false],
    [3, 4, true], [-3, -4, true], [0, 5, true], [10_000, 0, true], [Number.NaN, 0, false],
  ])("movement (%s, %s) activates: %s", (x, y, expected) => {
    expect(pastDragThreshold({ x: 100, y: 100 }, { x: 100 + x, y: 100 + y })).toBe(expected);
  });
});
