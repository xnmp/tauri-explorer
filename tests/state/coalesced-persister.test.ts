/**
 * Contract tests for the coalesced localStorage writer (#481).
 *
 * The contract is stated in terms of what actually reaches localStorage — how
 * many `setItem` calls land for a key and what the stored value ends up being
 * — because that is what the next app boot reads and what an fsync stall
 * costs. Nothing here inspects the writer's internal queue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCoalescedPersister } from "$lib/state/persisted";

const KEY = "coalesce-test";

/** A minimal EventTarget stand-in: the unit test env is `node`, so there is
 *  no real window/document to attach page-lifecycle listeners to. */
function fakeEventTarget() {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  return {
    addEventListener(type: string, fn: (e: Event) => void) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener(type: string, fn: (e: Event) => void) {
      listeners.get(type)?.delete(fn);
    },
    /** Fire every listener registered for `type`. */
    emit(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(new Event(type));
    },
    /** How many listeners are still attached for `type`. */
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

/** setItem calls that targeted `KEY`, newest last. */
function writes(spy: ReturnType<typeof vi.spyOn>): string[] {
  const calls = spy.mock.calls as [string, string][];
  return calls.filter((c) => c[0] === KEY).map((c) => c[1]);
}

let setItem: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  setItem = vi.spyOn(localStorage, "setItem");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createCoalescedPersister", () => {
  it("collapses a burst of scheduled values into a single write", () => {
    const persister = createCoalescedPersister<number>(KEY, 150);

    for (let i = 0; i < 10; i++) {
      persister.schedule(i);
      vi.advanceTimersByTime(10); // 10 writes 10ms apart: one burst
    }
    expect(writes(setItem)).toHaveLength(0); // nothing on the interaction path
    vi.advanceTimersByTime(150);

    expect(writes(setItem)).toHaveLength(1);
    persister.dispose();
  });

  it("stores the last value of the burst (latest wins)", () => {
    const persister = createCoalescedPersister<string>(KEY, 150);

    persister.schedule("first");
    persister.schedule("second");
    persister.schedule("third");
    vi.advanceTimersByTime(150);

    expect(localStorage.getItem(KEY)).toBe(JSON.stringify("third"));
    persister.dispose();
  });

  it("writes once per burst, not once per session — a later burst writes again", () => {
    const persister = createCoalescedPersister<string>(KEY, 150);

    persister.schedule("burst-1");
    vi.advanceTimersByTime(150);
    persister.schedule("burst-2");
    vi.advanceTimersByTime(150);

    expect(writes(setItem)).toEqual([JSON.stringify("burst-1"), JSON.stringify("burst-2")]);
    persister.dispose();
  });

  it("writeNow stores the value immediately and cancels a pending write", () => {
    const persister = createCoalescedPersister<string>(KEY, 150);

    persister.schedule("pending");
    persister.writeNow("now");

    expect(localStorage.getItem(KEY)).toBe(JSON.stringify("now"));
    expect(persister.hasPending).toBe(false);

    // The cancelled write must not resurrect the superseded value later.
    vi.advanceTimersByTime(500);
    expect(writes(setItem)).toEqual([JSON.stringify("now")]);
    persister.dispose();
  });

  it("flush stores a pending value without waiting for the window", () => {
    const persister = createCoalescedPersister<string>(KEY, 150);

    persister.schedule("queued");
    expect(persister.hasPending).toBe(true);
    persister.flush();

    expect(localStorage.getItem(KEY)).toBe(JSON.stringify("queued"));
    expect(persister.hasPending).toBe(false);
    persister.dispose();
  });

  it("flush with nothing pending writes nothing", () => {
    const persister = createCoalescedPersister<string>(KEY, 150);

    persister.flush();
    persister.flush();

    expect(writes(setItem)).toHaveLength(0);
    persister.dispose();
  });

  it("survives a value that cannot be serialized", () => {
    const persister = createCoalescedPersister<unknown>(KEY, 150);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    persister.schedule(circular);
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();

    // …and the writer still works afterwards.
    persister.writeNow("ok");
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify("ok"));
    persister.dispose();
  });

  describe("page lifecycle", () => {
    it("flushes a pending write when the page becomes hidden", () => {
      const doc = fakeEventTarget() as ReturnType<typeof fakeEventTarget> & {
        visibilityState: string;
      };
      doc.visibilityState = "visible";
      vi.stubGlobal("document", doc);
      const persister = createCoalescedPersister<string>(KEY, 150);

      persister.schedule("unsaved");
      doc.visibilityState = "hidden";
      doc.emit("visibilitychange");

      expect(localStorage.getItem(KEY)).toBe(JSON.stringify("unsaved"));
      persister.dispose();
    });

    it("does not write when the page merely becomes visible", () => {
      const doc = fakeEventTarget() as ReturnType<typeof fakeEventTarget> & {
        visibilityState: string;
      };
      doc.visibilityState = "visible";
      vi.stubGlobal("document", doc);
      const persister = createCoalescedPersister<string>(KEY, 150);

      persister.schedule("unsaved");
      doc.emit("visibilitychange");

      expect(writes(setItem)).toHaveLength(0);
      expect(persister.hasPending).toBe(true);
      persister.dispose();
    });

    it("flushes a pending write on pagehide and beforeunload", () => {
      for (const event of ["pagehide", "beforeunload"]) {
        localStorage.clear();
        const win = fakeEventTarget();
        vi.stubGlobal("window", win);
        const persister = createCoalescedPersister<string>(KEY, 150);

        persister.schedule(event);
        win.emit(event);

        expect(localStorage.getItem(KEY)).toBe(JSON.stringify(event));
        persister.dispose();
      }
    });

    it("dispose flushes the pending write and detaches its listeners", () => {
      const win = fakeEventTarget();
      const doc = fakeEventTarget();
      vi.stubGlobal("window", win);
      vi.stubGlobal("document", doc);
      const persister = createCoalescedPersister<string>(KEY, 150);

      persister.schedule("last");
      persister.dispose();

      expect(localStorage.getItem(KEY)).toBe(JSON.stringify("last"));
      expect(win.count("pagehide")).toBe(0);
      expect(win.count("beforeunload")).toBe(0);
      expect(doc.count("visibilitychange")).toBe(0);

      // Post-dispose lifecycle events must not reach the disposed writer.
      setItem.mockClear();
      win.emit("pagehide");
      doc.emit("visibilitychange");
      expect(writes(setItem)).toHaveLength(0);
    });

    it("scheduling after dispose writes immediately instead of queueing behind nothing", () => {
      const persister = createCoalescedPersister<string>(KEY, 150);
      persister.dispose();

      persister.schedule("after-dispose");

      // No lifecycle listener is left to flush a queued value, so holding it
      // would mean losing it — the write must land straight away.
      expect(localStorage.getItem(KEY)).toBe(JSON.stringify("after-dispose"));
      expect(persister.hasPending).toBe(false);

      // …and no orphaned timer fires a second write later.
      vi.advanceTimersByTime(500);
      expect(writes(setItem)).toHaveLength(1);
    });
  });
});
