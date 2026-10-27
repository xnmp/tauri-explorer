import { describe, expect, it } from "vitest";
import { revealProgressively, type FrameScheduler } from "../../src/lib/domain/progressive-reveal";

/** Frames end immediately; `now()` advances by `msPerRead` each time it is read. */
function clock(msPerRead = 0) {
  let t = 0;
  let frames = 0;
  const scheduler: FrameScheduler = { now: () => (t += msPerRead), nextFrame: async () => { frames++; } };
  return { scheduler, get frames() { return frames; } };
}

function* counted(blocks: string[], pulled: { count: number }) {
  for (const block of blocks) { pulled.count++; yield block; }
}

describe("revealProgressively (#1418)", () => {
  it("returns every block, showing each slice but the last as a growing prefix", async () => {
    const shown: (readonly string[])[] = [];
    const blocks = ["a".repeat(6), "b".repeat(6), "c".repeat(6), "d".repeat(6), "e"];
    const result = await revealProgressively(blocks, () => true, (b) => shown.push(b), clock().scheduler, { sliceMs: 1000, sliceChars: 10 });
    expect(result).toEqual(blocks);
    expect(shown).toEqual([blocks.slice(0, 2), blocks.slice(0, 4)]);
  });

  it("ends a slice when its time budget is spent", async () => {
    const shown: (readonly string[])[] = [];
    const c = clock(5);
    await revealProgressively(["a", "b", "c", "d"], () => true, (b) => shown.push(b), c.scheduler, { sliceMs: 8, sliceChars: 1e9 });
    // start=5; after a: now=10 (<8 elapsed? 5ms) continue; after b: 15 → 10ms elapsed, stop.
    expect(shown[0]).toEqual(["a", "b"]);
  });

  it("does no work before the first frame and stops pulling once no longer current", async () => {
    const pulled = { count: 0 };
    let current = true;
    let frame = 0;
    const scheduler: FrameScheduler = { now: () => 0, nextFrame: async () => { frame++; if (frame === 2) current = false; } };
    const shown: (readonly string[])[] = [];
    const result = await revealProgressively(counted(["a", "b", "c", "d", "e", "f"], pulled), () => current, (b) => shown.push(b), scheduler, { sliceMs: 1000, sliceChars: 2 });
    expect(result).toBeNull();
    expect(shown).toEqual([["a", "b"]]);
    expect(pulled.count).toBe(2);
  });

  it("pulls nothing when the request is already stale after the first frame", async () => {
    const pulled = { count: 0 };
    const result = await revealProgressively(counted(["a"], pulled), () => false, () => {}, clock().scheduler);
    expect(result).toBeNull();
    expect(pulled.count).toBe(0);
  });

  it("an empty document completes with no blocks", async () => {
    expect(await revealProgressively([], () => true, () => {}, clock().scheduler)).toEqual([]);
  });

  it("propagates a rendering error", async () => {
    function* failing() { yield "a"; throw new Error("boom"); }
    await expect(revealProgressively(failing(), () => true, () => {}, clock().scheduler, { sliceMs: 1000, sliceChars: 1 })).rejects.toThrow("boom");
  });
});
