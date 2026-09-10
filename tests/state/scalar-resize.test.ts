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

it("keeps a raw zero preference until adjusted and detects an external explicit-default change", () => {
  const f = fixture();
  f.setOptions({ min: 96, max: 800, default: 240, zeroIsDefault: true });
  f.setSource(0);
  expect(f.owner.value).toBe(240);
  f.owner.start(100, 1); f.owner.finish();
  expect(f.source()).toBe(0); expect(f.commits).toEqual([]);
  f.owner.start(100, 1); f.owner.move(130); f.frames[0]();
  expect(f.owner.value).toBe(270); expect(f.source()).toBe(0);
  f.setSource(240); f.owner.finish();
  expect(f.owner.value).toBe(240); expect(f.commits).toEqual([]);
});

it("changing source decoding supersedes a gesture even when its current numeric value is unchanged", () => {
  const f = fixture();
  f.setOptions({ min: 96, max: 800, default: 240 });
  f.owner.start(100, 1); f.owner.move(130); f.frames[0]();
  f.setOptions({ min: 96, max: 800, default: 240, zeroIsDefault: true });
  f.owner.finish();
  expect(f.source()).toBe(240); expect(f.commits).toEqual([]);
});

it("immediately projects a superseding source without retiring or committing from a read", () => {
  const f = fixture();
  f.owner.start(400, 1); f.owner.move(370); f.frames[0]();
  f.setSource(320);
  expect(f.owner.value).toBe(320);
  expect(f.events).toEqual([]); expect(f.commits).toEqual([]);
  f.owner.reconcile();
  expect(f.events).toEqual(["retire"]); expect(f.commits).toEqual([]);
});

it("immediately projects the current source for a superseding geometry before reactive reconciliation", () => {
  const f = fixture();
  f.owner.start(400, 1); f.owner.move(370); f.frames[0]();
  f.setOptions({ min: 300, max: 600, default: 320, axis: "x" });
  expect(f.owner.value).toBe(300);
  expect(f.events).toEqual([]); expect(f.commits).toEqual([]);
  f.owner.finish();
  expect(f.events).toEqual(["retire"]); expect(f.commits).toEqual([]);
});

it("disposal releases resources synchronously and finalizes only published work once without reopening input", () => {
  const f = fixture();
  f.owner.start(400, 1); f.owner.move(370); f.frames[0](); f.owner.move(300);
  const finalize = f.owner.dispose()!;
  expect(f.events).toEqual(["retire"]); expect(f.commits).toEqual([]);
  expect(f.owner.start(400, 1)).toBe(false); expect(f.owner.key("ArrowUp")).toBe(false);
  f.frames[1](); f.owner.move(100); f.owner.finish();
  finalize(); finalize(); f.owner.dispose();
  expect(f.source()).toBe(270); expect(f.commits).toEqual([270]);
});

for (const supersession of ["source", "geometry"] as const) {
  it(`a ${supersession} change after disposal prevents a deferred write`, () => {
    const f = fixture();
    f.owner.start(400, 1); f.owner.move(370); f.frames[0]();
    const finalize = f.owner.dispose()!;
    if (supersession === "source") f.setSource(320);
    else f.setOptions({ min: 160, max: 600, default: 280, axis: "x", invert: true });
    finalize(); expect(f.commits).toEqual([]);
    expect(f.source()).toBe(supersession === "source" ? 320 : 240);
  });
}

it("retiring just a handle allows replacement input which supersedes its deferred write", () => {
  const f = fixture();
  f.owner.start(400, 1); f.owner.move(370); f.frames[0]();
  const finalize = f.owner.retire()!;
  expect(f.owner.start(400, 1)).toBe(true);
  finalize(); expect(f.commits).toEqual([]);
  f.owner.move(390); f.owner.finish(); expect(f.source()).toBe(250);
});

it("parent disposal can follow handle retirement without losing or repeating its final write", () => {
  const f = fixture();
  f.owner.start(400, 1); f.owner.move(370); f.frames[0]();
  const finalize = f.owner.retire()!;
  f.owner.dispose(); finalize(); finalize();
  expect(f.commits).toEqual([270]); expect(f.events).toEqual(["retire", "commit"]);
});

for (const action of ["restart", "keyboard"] as const) {
  it(`disposal during input retirement prevents ${action} from reopening or committing`, () => {
    const commits: number[] = [];
    let disposeOnRetire = false;
    const owner = createScalarResize({ read: () => 240,
      options: () => ({ min: 96, max: 800, default: 240 }),
      schedule: () => () => {}, publish: () => {}, commit: value => commits.push(value),
      retire: () => { if (disposeOnRetire) owner.dispose(); },
    });
    owner.start(100, 1); disposeOnRetire = true;
    if (action === "restart") expect(owner.start(100, 1)).toBe(false);
    else owner.key("ArrowRight");
    owner.move(200); owner.finish();
    expect(commits).toEqual([]);
  });
}

it("start does not report live ownership if publication disposes it synchronously", () => {
  const owner = createScalarResize({ read: () => 240,
    options: () => ({ min: 96, max: 800, default: 240 }),
    schedule: () => () => {}, retire: () => {}, commit: () => {},
    publish: (_value, active) => { if (active) owner.dispose(); },
  });
  expect(owner.start(100, 1)).toBe(false);
});

for (const replacement of ["dispose", "start"] as const) {
  it(`keyboard commit which triggers ${replacement} cannot publish stale inactive state`, () => {
    let source = 240;
    const publications: [number, boolean][] = [];
    const owner = createScalarResize({ read: () => source,
      options: () => ({ min: 96, max: 800, default: 240 }),
      schedule: () => () => {}, retire: () => {},
      publish: (value, active) => publications.push([value, active]),
      commit: value => { source = value; if (replacement === "dispose") owner.dispose(); else owner.start(100, 1); },
    });
    expect(owner.key("ArrowRight")).toBe(true);
    expect(source).toBe(250);
    expect(publications).toEqual(replacement === "dispose" ? [] : [[250, true]]);
  });
}
