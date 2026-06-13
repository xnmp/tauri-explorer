/**
 * Progressive render transition logic: a large entry-count jump must restart
 * chunked rendering (one chunk first frame), shrinks clamp without restarting,
 * and small increases extend immediately. Regression context: the original
 * TilesView $effect read its own write target, collapsing all chunks into a
 * single frame — the decision logic now lives in this pure function.
 */
import { describe, it, expect } from "vitest";
import { nextProgressiveState } from "$lib/composables/use-progressive-render.svelte";

const CHUNK = 60;

describe("nextProgressiveState", () => {
  const initial = { limit: CHUNK, prevCount: 0 };

  it("restarts chunked rendering on a large jump (new directory)", () => {
    const next = nextProgressiveState(initial, 300, CHUNK);
    expect(next).toEqual({ limit: CHUNK, prevCount: 300, chunking: true });
  });

  it("renders a small directory fully in one pass", () => {
    const next = nextProgressiveState(initial, 30, CHUNK);
    expect(next).toEqual({ limit: 30, prevCount: 30, chunking: false });
  });

  it("clamps when entries shrink (e.g. bulk delete) without restarting", () => {
    const mid = { limit: 120, prevCount: 300 };
    const next = nextProgressiveState(mid, 30, CHUNK);
    expect(next).toEqual({ limit: 30, prevCount: 30, chunking: false });
  });

  it("extends immediately for a small increase (e.g. new folder created)", () => {
    const settled = { limit: 30, prevCount: 30 };
    const next = nextProgressiveState(settled, 31, CHUNK);
    expect(next).toEqual({ limit: 31, prevCount: 31, chunking: false });
  });

  it("treats an increase of exactly one chunk as a small increase", () => {
    const settled = { limit: 30, prevCount: 30 };
    const next = nextProgressiveState(settled, 30 + CHUNK, CHUNK);
    expect(next).toEqual({ limit: 30 + CHUNK, prevCount: 30 + CHUNK, chunking: false });
  });

  it("restarts chunking when navigating from a settled small dir to a huge one", () => {
    const settled = { limit: 30, prevCount: 30 };
    const next = nextProgressiveState(settled, 5000, CHUNK);
    expect(next).toEqual({ limit: CHUNK, prevCount: 5000, chunking: true });
  });

  it("handles an empty directory", () => {
    const next = nextProgressiveState(initial, 0, CHUNK);
    expect(next).toEqual({ limit: 0, prevCount: 0, chunking: false });
  });

  it("does not re-chunk when the count is unchanged (silent refresh)", () => {
    const settled = { limit: 300, prevCount: 300 };
    const next = nextProgressiveState(settled, 300, CHUNK);
    expect(next).toEqual({ limit: 300, prevCount: 300, chunking: false });
  });
});
