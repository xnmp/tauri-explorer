import { describe, expect, it } from "vitest";
import { createTabStripMotion, type FrameScheduler } from "$lib/composables/tab-strip-motion.svelte";
import { stripTabsOf } from "$lib/domain/tab-strip-motion";
import { TAB_SLIDE_IN_MS, TAB_SLIDE_OUT_MS } from "$lib/domain/tab-slide";

/** Frames that run only when the test says so. */
function manualFrames() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const scheduler: FrameScheduler = {
    request: (callback) => { pending.set(next, callback); return next++; },
    cancel: (handle) => { pending.delete(handle); },
  };
  return {
    scheduler,
    get pending() { return pending.size; },
    run() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
}

const tabs = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (motion: { strip: { ids: ReadonlySet<string> } }) => [...motion.strip.ids];

describe("createTabStripMotion", () => {
  it("starts with the given tabs, no glide and a start that moves at once", () => {
    const motion = createTabStripMotion(stripTabsOf(tabs("a"), "a"), manualFrames().scheduler);
    expect(ids(motion)).toEqual(["a"]);
    expect(motion.gliding).toBe(false);
    expect(motion.startEaseMs).toBe(0);
    expect(motion.widthEaseMs).toBe(TAB_SLIDE_IN_MS);
  });

  it("an opening tab joins the strip a frame later, with the start easing and the reveal gliding", () => {
    const frames = manualFrames();
    const motion = createTabStripMotion(stripTabsOf(tabs("a"), "a"), frames.scheduler);
    motion.follow(stripTabsOf(tabs("a", "b"), "b"));
    expect(ids(motion)).toEqual(["a"]);
    expect(motion.strip.activeId).toBe("a");
    expect(motion.gliding).toBe(true);
    expect(motion.startEaseMs).toBe(TAB_SLIDE_IN_MS);
    expect(motion.widthEaseMs).toBe(TAB_SLIDE_IN_MS);
    frames.run();
    expect(ids(motion)).toEqual(["a", "b"]);
    expect(motion.strip.activeId).toBe("b");
  });

  it("a closing tab leaves the strip a frame later, easing over the closing slide", () => {
    const frames = manualFrames();
    const motion = createTabStripMotion(stripTabsOf(tabs("a", "b"), "b"), frames.scheduler);
    motion.follow(stripTabsOf(tabs("a"), "a"));
    expect(motion.widthEaseMs).toBe(TAB_SLIDE_OUT_MS);
    expect(motion.startEaseMs).toBe(TAB_SLIDE_OUT_MS);
    expect(ids(motion)).toEqual(["a", "b"]);
    frames.run();
    expect(ids(motion)).toEqual(["a"]);
  });

  it("switching tabs updates the strip at once, without a glide or a start ease", () => {
    const frames = manualFrames();
    const motion = createTabStripMotion(stripTabsOf(tabs("a", "b"), "a"), frames.scheduler);
    motion.follow(stripTabsOf(tabs("a", "b"), "b"));
    expect(frames.pending).toBe(0);
    expect(motion.strip.activeId).toBe("b");
    expect(motion.gliding).toBe(false);
    expect(motion.startEaseMs).toBe(0);
  });

  it("a superseded change is cancelled: the strip adopts only the latest tabs", () => {
    const frames = manualFrames();
    const motion = createTabStripMotion(stripTabsOf(tabs("a"), "a"), frames.scheduler);
    const cancel = motion.follow(stripTabsOf(tabs("a", "b"), "b"));
    cancel();
    motion.follow(stripTabsOf(tabs("a", "b", "c"), "c"));
    expect(frames.pending).toBe(1);
    frames.run();
    expect(ids(motion)).toEqual(["a", "b", "c"]);
  });

  it("a switch within a slide's frame cancels it and lays out the tabs at once", () => {
    const frames = manualFrames();
    const motion = createTabStripMotion(stripTabsOf(tabs("a", "b"), "a"), frames.scheduler);
    // Opening "c" defers; the effect's cleanup cancels it when the tabs change again.
    const cancel = motion.follow(stripTabsOf(tabs("a", "b", "c"), "c"));
    cancel();
    // Against the strip it still lays out (two tabs), three tabs is a slide again.
    motion.follow(stripTabsOf(tabs("a", "b", "c"), "a"));
    frames.run();
    expect(ids(motion)).toEqual(["a", "b", "c"]);
    expect(motion.strip.activeId).toBe("a");
  });

  it("a window resize makes the start move at once, and the slide's end stops the glide", () => {
    const frames = manualFrames();
    const motion = createTabStripMotion(stripTabsOf(tabs("a"), "a"), frames.scheduler);
    motion.follow(stripTabsOf(tabs("a", "b"), "b"));
    motion.startMovesAtOnce();
    expect(motion.startEaseMs).toBe(0);
    motion.slideEnded();
    expect(motion.gliding).toBe(false);
  });
});
