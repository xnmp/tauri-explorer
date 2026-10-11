import { describe, it, expect, vi } from "vitest";
import { createUnresolvedAiCount } from "$lib/state/ai-operations.svelte";

const flush = () => new Promise((r) => setTimeout(r, 0));
function setup(initial: { active?: boolean }[] = []) {
  let ops = initial, fail = false, notify = () => {};
  const unwatch = vi.fn();
  const watch = vi.fn(async (receive: () => void) => { notify = receive; return unwatch; });
  const read = vi.fn(async () => { if (fail) throw new Error("boom"); return { operations: ops }; });
  return { store: createUnresolvedAiCount({ read, watch }), watch, unwatch, read,
    set: (o: { active?: boolean }[]) => { ops = o; notify(); }, failNext: () => { fail = true; notify(); } };
}

describe("unresolved AI count", () => {
  it("reads the snapshot and follows change events while subscribed", async () => {
    const t = setup([{}]);
    const release = t.store.subscribe(); await flush();
    expect(t.store.count).toBe(1);
    t.set([{}, {}, {}]); await flush();
    expect(t.store.count).toBe(3);
    release();
  });
  it("does not count operations whose job is still actively running", async () => {
    const t = setup([{ active: true }]);
    const release = t.store.subscribe(); await flush();
    expect(t.store.count).toBe(0);
    t.set([{ active: true }, { active: false }, {}]); await flush();
    expect(t.store.count).toBe(2);
    release();
  });
  it("shares one watch across consumers and stops after the last release", async () => {
    const t = setup();
    const a = t.store.subscribe(), b = t.store.subscribe(); await flush();
    expect(t.watch).toHaveBeenCalledTimes(1);
    a(); a(); expect(t.unwatch).not.toHaveBeenCalled();
    b(); expect(t.unwatch).toHaveBeenCalledTimes(1);
  });
  it("shows nothing when reads fail", async () => {
    const t = setup([{}]);
    const release = t.store.subscribe(); await flush();
    t.failNext(); await flush();
    expect(t.store.count).toBe(0);
    release();
  });
});
