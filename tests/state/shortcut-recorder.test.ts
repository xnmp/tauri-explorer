import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShortcutRecorder } from "$lib/state/shortcut-recorder";
import { CHORD_TIMEOUT_MS, type ShortcutRecording } from "$lib/domain/shortcut-recording";

describe("shortcut recorder contract", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function fixture() {
    let current: ShortcutRecording | null = null;
    const expired = vi.fn();
    const recorder = createShortcutRecorder((value) => { current = value; }, expired);
    return { recorder, expired, snapshot: () => current };
  }
  it("records both steps without publishing an incomplete shortcut", () => {
    const f = fixture();
    f.recorder.start("up", "chord");
    expect(f.recorder.capture("Alt+M")).toBeNull();
    expect(f.snapshot()?.prefix).toBe("Alt+M");
    expect(f.recorder.capture("M")).toEqual({ commandId: "up", shortcut: "Alt+M M" });
    expect(f.snapshot()).toBeNull();
    vi.advanceTimersByTime(CHORD_TIMEOUT_MS);
    expect(f.expired).not.toHaveBeenCalled();
  });
  it("expires exactly at the shared runtime chord deadline", () => {
    const f = fixture();
    f.recorder.start("up", "chord");
    f.recorder.capture("Alt+M");
    vi.advanceTimersByTime(CHORD_TIMEOUT_MS - 1);
    expect(f.snapshot()?.prefix).toBe("Alt+M");
    vi.advanceTimersByTime(1);
    expect(f.snapshot()).toBeNull();
    expect(f.expired).toHaveBeenCalledOnce();
    expect(f.recorder.capture("M")).toBeNull();
  });
  it.each(["", "Ctrl", "Alt+", "M T"])("rejects malformed captured step %s and discards its prefix", (step) => {
    const f = fixture();
    f.recorder.start("up", "chord");
    f.recorder.capture("Alt+M");
    expect(f.recorder.capture(step)).toBeNull();
    expect(f.snapshot()).toBeNull();
  });
  it("cancelling or restarting makes an old deadline unable to clear its replacement", () => {
    const f = fixture();
    f.recorder.start("old", "chord");
    f.recorder.capture("Alt+M");
    vi.advanceTimersByTime(1000);
    f.recorder.cancel();
    f.recorder.start("new", "chord");
    f.recorder.capture("Ctrl+K");
    vi.advanceTimersByTime(500);
    expect(f.snapshot()?.commandId).toBe("new");
    expect(f.recorder.capture("C")).toEqual({ commandId: "new", shortcut: "Ctrl+K C" });
    expect(f.expired).not.toHaveBeenCalled();
  });
  it("single-step recording retains immediate completion", () => {
    const f = fixture();
    f.recorder.start("copy", "single");
    expect(f.recorder.capture("Ctrl+C")).toEqual({ commandId: "copy", shortcut: "Ctrl+C" });
  });
});
