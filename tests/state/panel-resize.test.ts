import { describe, expect, it } from "vitest";
import { createPanelResize } from "$lib/state/panel-resize";
import { draggedPanelWidth, panelWidth, panelWidthFromKey } from "$lib/domain/panel-width";

const options = { min: 180, max: 400, default: 240 };
function fixture() {
  const frames: (() => void)[] = [], persisted: number[] = [], visible: [number, boolean][] = [];
  const owner = createPanelResize(240, options, {
    schedule: callback => { frames.push(callback); return () => {}; },
    publish: (width, active) => visible.push([width, active]),
    persist: width => persisted.push(width),
  });
  return { owner, frames, persisted, visible };
}

describe("panel width contracts", () => {
  it("normalizes malformed saved values and clamps finite extremes", () => {
    for (const value of [null, undefined, "300", NaN, Infinity, {}, []]) expect(panelWidth(value, options)).toBe(240);
    expect(panelWidth(-1e100, options)).toBe(180);
    expect(panelWidth(1e100, options)).toBe(400);
  });
  it("converts visual movement to CSS width and honors left-side handles", () => {
    expect(draggedPanelWidth(240, 60, 1.5, options)).toBe(280);
    expect(draggedPanelWidth(240, 60, 0.8, options)).toBe(315);
    expect(draggedPanelWidth(240, -60, 1.5, { ...options, invert: true })).toBe(280);
    for (const scale of [0, -1, NaN, Infinity]) expect(draggedPanelWidth(240, 60, scale, options)).toBe(240);
    expect(panelWidthFromKey(240, "ArrowRight", { ...options, invert: true })).toBe(230);
  });
  it("coalesces movement, publishes the last release position and persists once", () => {
    const { owner, frames, persisted, visible } = fixture();
    owner.start(100, 1.5); owner.move(130); owner.move(160);
    expect(owner.width).toBe(240); expect(frames).toHaveLength(1);
    owner.finish();
    expect(owner.width).toBe(280); expect(persisted).toEqual([280]);
    expect(visible.at(-1)).toEqual([280, false]);
    frames[0](); expect(persisted).toEqual([280]);
  });
  it("cancellation discards queued movement but retains and saves rendered work", () => {
    const { owner, frames, persisted } = fixture();
    owner.start(100, 1); owner.move(120); frames[0]();
    owner.move(160); owner.cancel(); frames[1]();
    expect(owner.width).toBe(260); expect(persisted).toEqual([260]);
    owner.move(200); owner.finish(); expect(persisted).toEqual([260]);
  });
  it("old frames cannot mutate a replacement gesture", () => {
    const { owner, frames } = fixture();
    owner.start(100, 1); owner.move(160);
    owner.start(200, 2); frames[0](); owner.move(220); owner.finish();
    expect(owner.width).toBe(250);
  });
  it("keyboard sizing respects bounds and retires pending pointer work", () => {
    const { owner, frames, persisted } = fixture();
    owner.start(100, 1); owner.move(200);
    expect(owner.key("ArrowDown")).toBe(false);
    expect(owner.key("ArrowRight")).toBe(true); frames[0]();
    expect(owner.width).toBe(250);
    owner.key("Home"); expect(owner.width).toBe(180);
    owner.key("End"); owner.key("ArrowRight"); expect(owner.width).toBe(400);
    expect(persisted).toEqual([250, 180, 400]);
  });
});

it("finishing an old gesture cannot cancel a replacement started by its publication", () => {
  const persisted: number[] = [];
  let replace = true;
  const owner = createPanelResize(240, options, {
    schedule: () => () => {},
    publish(width, active) {
      if (active && width === 260 && replace) { replace = false; owner.start(200, 1); }
    },
    persist: width => persisted.push(width),
  });
  owner.start(100, 1); owner.move(120); owner.finish();
  owner.move(230); owner.finish();
  expect(owner.width).toBe(290);
  expect(persisted).toEqual([260, 290]);
});
