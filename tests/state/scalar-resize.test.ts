import { expect, it } from "vitest";
import { createScalarResize } from "$lib/state/scalar-resize";
import type { ResizeSizeOptions } from "$lib/domain/resize-size";

function fixture() {
  let source = 240;
  let options: ResizeSizeOptions = { min: 96, max: 800, default: 240, axis: "y", invert: true, integer: true };
  const frames: (() => void)[] = [], commits: number[] = [], events: string[] = [];
  const owner = createScalarResize({ read: () => source, options: () => options,
    schedule: cb => { frames.push(cb); return () => {}; },
    retire: () => { events.push("retire"); }, publish: () => {},
    commit: value => { events.push("commit"); source = value; commits.push(value); },
  });
  return { owner, frames, commits, events, source: () => source,
    setSource(value: number) { source = value; }, setOptions(value: ResizeSizeOptions) { options = value; } };
}

it("renders coalesced rounded drafts without changing the committed source, then retires before one commit", () => {
  const f = fixture();
  f.owner.start(400, 1.5); f.owner.move(399); f.frames[0]();
  expect(f.owner.value).toBe(241); expect(f.source()).toBe(240); expect(f.commits).toEqual([]);
  f.owner.move(370); f.owner.move(340); f.owner.finish();
  expect(f.owner.value).toBe(280); expect(f.source()).toBe(280);
  expect(f.events).toEqual(["retire", "commit"]); expect(f.commits).toEqual([280]);
  f.frames[1](); f.owner.cancel(); expect(f.commits).toEqual([280]);
});
it("ordinary interruption commits only the published draft and drops a late pending sample", () => {
  const f = fixture();
  f.owner.start(400, 1); f.owner.move(370); f.frames[0]();
  f.owner.move(300); f.owner.cancel(); f.frames[1]();
  expect(f.owner.value).toBe(270); expect(f.commits).toEqual([270]);
});
it("a changed committed source discards published and pending drafts without overwriting the source", () => {
  const f = fixture();
  f.owner.start(400, 1); f.owner.move(370); f.frames[0](); f.owner.move(300);
  f.setSource(320); f.owner.reconcile(); f.frames[1](); f.owner.finish();
  expect(f.owner.value).toBe(320); expect(f.commits).toEqual([]); expect(f.events).toEqual(["retire"]);
});
it("source reconciliation leaves an unchanged source and a subsequent gesture after own commit alone", () => {
  const f = fixture();
  f.owner.start(400, 1); f.owner.move(370); f.owner.reconcile(); f.owner.finish();
  f.owner.start(400, 1); f.owner.move(390); f.owner.reconcile(); f.owner.finish();
  expect(f.commits).toEqual([270, 280]);
});
it("changed axis/bounds supersede a captured gesture without committing to the replacement dimension", () => {
  const f = fixture();
  f.owner.start(400, 1); f.owner.move(370); f.frames[0](); f.owner.move(300);
  f.setOptions({ min: 160, max: 600, default: 320, axis: "x", invert: true });
  f.owner.reconcile(); f.frames[1](); f.owner.finish();
  expect(f.owner.value).toBe(240); expect(f.commits).toEqual([]);
});
it("a queued frame cannot publish into changed options before reactive reconciliation", () => {
  const f = fixture();
  f.owner.start(400, 2); f.owner.move(360);
  f.setOptions({ min: 160, max: 600, default: 320, axis: "x", invert: false });
  f.frames[0](); expect(f.owner.value).toBe(240);
  f.owner.reconcile(); expect(f.commits).toEqual([]);
});
it("keyboard arrows use the current axis and invert growth, while no-op/rejected input never commits", () => {
  const f = fixture();
  expect(f.owner.key("ArrowLeft")).toBe(false);
  f.owner.key("ArrowUp"); expect(f.source()).toBe(250);
  f.owner.key("Home"); f.owner.key("ArrowDown"); expect(f.source()).toBe(96);
  f.owner.key("End"); expect(f.source()).toBe(800); expect(f.commits).toEqual([250, 96, 800]);
  for (const scale of [0, -1, NaN, Infinity]) expect(f.owner.start(100, scale)).toBe(false);
  expect(f.owner.start(NaN, 1)).toBe(false);
  f.owner.start(100, 1); f.owner.move(Infinity); f.owner.finish();
  expect(f.commits).toEqual([250, 96, 800]);
});

for (const action of ["cancel", "finish", "restart", "keyboard"] as const) {
  it(`external source wins synchronous ${action} before reactive reconciliation`, () => {
    const f = fixture();
    f.owner.start(400, 1); f.owner.move(370); f.frames[0](); f.owner.move(300);
    f.setSource(320);
    if (action === "cancel") f.owner.cancel();
    if (action === "finish") f.owner.finish();
    if (action === "restart") { f.owner.start(400, 1); f.owner.finish(); }
    if (action === "keyboard") f.owner.key("ArrowUp");
    f.frames[1]();
    expect(f.source()).toBe(action === "keyboard" ? 330 : 320);
    expect(f.commits).toEqual(action === "keyboard" ? [330] : []);
  });
}

it("an old-axis key retires superseded input ownership even when the new axis does not handle it", () => {
  const f = fixture();
  f.owner.start(400, 1); f.owner.move(370); f.frames[0]();
  f.setOptions({ min: 160, max: 600, default: 320, axis: "x" });
  expect(f.owner.key("ArrowUp")).toBe(false);
  expect(f.owner.value).toBe(240); expect(f.events).toEqual(["retire"]); expect(f.commits).toEqual([]);
});

it("an omitted axis captures x even when the source options change before reconciliation", () => {
  const f = fixture();
  f.setOptions({ min: 96, max: 800, default: 240 });
  f.owner.start(100, 1);
  f.setOptions({ min: 96, max: 800, default: 240, axis: "y" });
  expect(f.owner.axis).toBe("x");
  f.owner.reconcile(); expect(f.owner.axis).toBe("y");
});
