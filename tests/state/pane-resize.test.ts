import { expect, it, vi } from "vitest";
import { createPaneResize } from "$lib/state/pane-resize";

function fixture() {
  const frames: (() => void)[] = [];
  const cancelFrame = vi.fn();
  const publish = vi.fn();
  return { frames, cancelFrame, publish, resize: createPaneResize({
    schedule: (callback) => { frames.push(callback); return cancelFrame; },
    publishActive: publish,
  }) };
}

it("coalesces pointer movement into the latest ratio and flushes the final move once", () => {
  const { resize, frames, cancelFrame, publish } = fixture();
  const commit = vi.fn(() => true);
  resize.start({ direction: "row", start: 100, extent: 200, commit });
  for (let x = 100; x <= 250; x++) resize.move(x, 0);
  expect(frames).toHaveLength(1);
  frames[0]();
  expect(commit.mock.calls).toEqual([[0.75]]);
  resize.move(200, 0);
  resize.finish();
  frames[1](); // Already-delivered callback cannot apply after mouseup.
  expect(commit.mock.calls).toEqual([[0.75], [0.5]]);
  expect(cancelFrame).toHaveBeenCalledOnce();
  expect(publish.mock.calls).toEqual([[true], [false]]);
});

it("canceled and replaced drags cannot commit late frames into their replacement", () => {
  const { resize, frames } = fixture();
  const oldCommit = vi.fn(() => true);
  const newCommit = vi.fn(() => true);
  resize.start({ direction: "row", start: 0, extent: 100, commit: oldCommit });
  resize.move(20, 0);
  resize.start({ direction: "column", start: 10, extent: 200, commit: newCommit });
  resize.move(0, 60);
  frames[0]();
  frames[1]();
  expect(oldCommit).not.toHaveBeenCalled();
  expect(newCommit.mock.calls).toEqual([[0.25]]);
  resize.move(0, 80);
  resize.cancel();
  frames[2]();
  expect(newCommit).toHaveBeenCalledOnce();
});

it("retires a drag whose original layout no longer accepts updates", () => {
  const { resize, frames, publish } = fixture();
  const commit = vi.fn(() => false);
  resize.start({ direction: "row", start: 0, extent: 100, commit });
  resize.move(50, 0);
  frames[0]();
  resize.move(60, 0);
  expect(commit).toHaveBeenCalledOnce();
  expect(frames).toHaveLength(1);
  expect(publish.mock.calls).toEqual([[true], [false]]);
});

it("ignores non-finite pointer coordinates and unusable geometry", () => {
  const { resize, frames, publish } = fixture();
  const commit = vi.fn(() => true);
  for (const extent of [0, -1, NaN, Infinity]) {
    resize.start({ direction: "row", start: 0, extent, commit });
    resize.move(20, 0);
  }
  expect(publish).not.toHaveBeenCalled();
  resize.start({ direction: "row", start: 0, extent: 100, commit });
  resize.move(NaN, 0);
  resize.move(Infinity, 0);
  resize.finish();
  expect(frames).toHaveLength(0);
  expect(commit).not.toHaveBeenCalled();
  resize.start({ direction: "row", start: -Number.MAX_VALUE, extent: Number.MIN_VALUE, commit });
  resize.move(Number.MAX_VALUE, 0);
  resize.finish();
  expect(commit).not.toHaveBeenCalled();
});
