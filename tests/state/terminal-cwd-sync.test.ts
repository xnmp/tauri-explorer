import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTerminalCwdSync, type CwdSyncStatus } from "$lib/state/terminal-cwd-sync";

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function setup(initial: { id?: number | null; active?: string; follows?: boolean } = {}) {
  const env = {
    id: initial.id === undefined ? 1 : initial.id,
    active: initial.active as string | undefined,
    follows: initial.follows ?? true,
    status: vi.fn<(id: number) => Promise<CwdSyncStatus>>(),
    injected: [] as string[],
    toasts: 0,
    errors: [] as string[],
  };
  const sync = createTerminalCwdSync({
    sessionId: () => env.id,
    queryStatus: (id) => env.status(id),
    normalizeCwd: (raw) => raw,
    activePath: () => env.active,
    followsExplorer: () => env.follows,
    injectCd: (p) => { env.injected.push(p); },
    notifyQueued: () => { env.toasts++; },
    reportError: (m) => { env.errors.push(m); },
    scheduler: {
      every: (ms, fn) => {
        const h = setInterval(fn, ms);
        return () => clearInterval(h);
      },
    },
  });
  return { env, sync };
}

const idle = (cwd: string | null = "/shell"): CwdSyncStatus => ({ cwd, busy: false });
const busy = (cwd: string | null = "/shell"): CwdSyncStatus => ({ cwd, busy: true });

describe("terminal cwd sync", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  describe("immediate decisions", () => {
    it("writes a cd when the shell is idle elsewhere", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValue(idle());
      await sync.sync("/a");
      expect(env.injected).toEqual(["/a"]);
      expect(sync.state.kind).toBe("idle");
    });

    it("skips when the shell is already there", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValue(idle("/a"));
      await sync.sync("/a");
      expect(env.injected).toEqual([]);
    });

    it("skips a busy shell that is already at the target without queueing", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValue(busy("/a"));
      await sync.sync("/a");
      expect(sync.state.kind).toBe("idle");
      expect(env.toasts).toBe(0);
    });

    it("skips virtual locations", async () => {
      const { env, sync } = setup({ active: "trash://" });
      env.status.mockResolvedValue(idle());
      await sync.sync("trash://");
      expect(env.injected).toEqual([]);
    });

    it("does nothing without a session", async () => {
      const { env, sync } = setup({ id: null, active: "/a" });
      await sync.sync("/a");
      expect(env.status).not.toHaveBeenCalled();
    });

    it.each([["" ], [null as unknown as string], [undefined as unknown as string]])(
      "never queries or writes for an empty path (%s)", async (p) => {
        const { env, sync } = setup({ active: p });
        env.status.mockResolvedValue(idle());
        await sync.sync(p);
        expect(env.status).not.toHaveBeenCalled();
        expect(env.injected).toEqual([]);
      });

    it("drops a stale sync when the active tab moved on during the status query", async () => {
      const { env, sync } = setup({ active: "/a" });
      const d = deferred<CwdSyncStatus>();
      env.status.mockReturnValue(d.promise);
      const p = sync.sync("/a");
      env.active = "/b";
      d.resolve(idle());
      await p;
      expect(env.injected).toEqual([]);
    });


    it("propagates a rejected status query to the caller", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockRejectedValue(new Error("dead"));
      await expect(sync.sync("/a")).rejects.toThrow("dead");
      expect(sync.state.kind).toBe("idle");
    });
  });

  describe("queueing", () => {
    it("queues behind a busy command, toasts once, and writes when it finishes", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValueOnce(busy());
      await sync.sync("/a");
      expect(sync.state).toMatchObject({ kind: "queued", target: "/a" });
      expect(env.toasts).toBe(1);

      env.status.mockResolvedValue(busy());
      await vi.advanceTimersByTimeAsync(500);
      expect(env.injected).toEqual([]);
      expect(sync.state.kind).toBe("queued");

      env.status.mockResolvedValue(idle());
      await vi.advanceTimersByTimeAsync(500);
      expect(env.injected).toEqual(["/a"]);
      expect(sync.state.kind).toBe("idle");
      // timer stopped
      env.status.mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      expect(env.status).not.toHaveBeenCalled();
    });

    it("a newer target supersedes the queued one without a second toast", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValue(busy());
      await sync.sync("/a");
      env.active = "/b";
      await sync.sync("/b");
      expect(sync.state).toMatchObject({ kind: "queued", target: "/b" });
      expect(env.toasts).toBe(1);
      env.status.mockResolvedValue(idle());
      await vi.advanceTimersByTimeAsync(500);
      expect(env.injected).toEqual(["/b"]);
    });

    it("toasts again for a new queue episode after the previous drained", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValue(busy());
      await sync.sync("/a");
      env.status.mockResolvedValue(idle());
      await vi.advanceTimersByTimeAsync(500);
      env.active = "/b";
      env.status.mockResolvedValue(busy());
      await sync.sync("/b");
      expect(env.toasts).toBe(2);
    });

    it("does not write the queued cd if the active tab moved on meanwhile", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValue(busy());
      await sync.sync("/a");
      env.active = "/other";
      env.status.mockResolvedValue(idle());
      await vi.advanceTimersByTimeAsync(500);
      expect(env.injected).toEqual([]);
      expect(sync.state.kind).toBe("idle");
    });

    it("does not write if the command itself cd'd to the target", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValue(busy());
      await sync.sync("/a");
      env.status.mockResolvedValue(idle("/a"));
      await vi.advanceTimersByTimeAsync(500);
      expect(env.injected).toEqual([]);
    });

    it("ignores a tick while the previous status query is in flight (#154)", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValueOnce(busy());
      await sync.sync("/a");
      const d = deferred<CwdSyncStatus>();
      env.status.mockReturnValue(d.promise);
      await vi.advanceTimersByTimeAsync(500);
      await vi.advanceTimersByTimeAsync(1500);
      expect(env.status).toHaveBeenCalledTimes(2); // sync + exactly one tick
      d.resolve(idle());
      await vi.advanceTimersByTimeAsync(0);
      expect(env.injected).toEqual(["/a"]); // once, never 'null'
    });

    it("writes the latest target when superseded during an in-flight tick", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValueOnce(busy());
      await sync.sync("/a");
      const d = deferred<CwdSyncStatus>();
      env.status.mockReturnValueOnce(d.promise);
      await vi.advanceTimersByTimeAsync(500);
      env.active = "/b";
      env.status.mockResolvedValueOnce(busy());
      await sync.sync("/b");
      d.resolve(idle());
      await vi.advanceTimersByTimeAsync(0);
      expect(env.injected).toEqual(["/b"]);
    });

    it("stops polling and goes idle when the status query rejects", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValueOnce(busy());
      await sync.sync("/a");
      env.status.mockRejectedValue(new Error("gone"));
      await vi.advanceTimersByTimeAsync(500);
      expect(sync.state.kind).toBe("idle");
      expect(env.errors).toHaveLength(1);
      env.status.mockClear();
      await vi.advanceTimersByTimeAsync(3000);
      expect(env.status).not.toHaveBeenCalled();
    });

    it("stops polling when the session disappears", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValue(busy());
      await sync.sync("/a");
      env.id = null;
      await vi.advanceTimersByTimeAsync(500);
      expect(sync.state.kind).toBe("idle");
    });
  });

  describe("lifecycle", () => {
    it("shell exit while queued cancels the queue and re-arms the toast", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValue(busy());
      await sync.sync("/a");
      sync.shellExited();
      expect(sync.state.kind).toBe("idle");
      env.status.mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      expect(env.status).not.toHaveBeenCalled();
      await sync.sync("/a");
      expect(env.toasts).toBe(2);
    });


    it("a status result landing after exit writes nothing (sync)", async () => {
      const { env, sync } = setup({ active: "/a" });
      const d = deferred<CwdSyncStatus>();
      env.status.mockReturnValue(d.promise);
      const p = sync.sync("/a");
      sync.shellExited();
      d.resolve(idle());
      await p;
      expect(env.injected).toEqual([]);
      expect(sync.state.kind).toBe("idle");
    });

    it("a busy result landing after restart does not queue against the new shell", async () => {
      const { env, sync } = setup({ active: "/a" });
      const d = deferred<CwdSyncStatus>();
      env.status.mockReturnValue(d.promise);
      const p = sync.sync("/a");
      sync.reset();
      d.resolve(busy());
      await p;
      expect(sync.state.kind).toBe("idle");
      expect(env.toasts).toBe(0);
    });

    it("an in-flight poll tick resolving after restart writes nothing, even to the new session", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValueOnce(busy());
      await sync.sync("/a");
      const d = deferred<CwdSyncStatus>();
      env.status.mockReturnValue(d.promise);
      await vi.advanceTimersByTimeAsync(500);
      sync.reset();
      env.id = 2;
      d.resolve(idle());
      await vi.advanceTimersByTimeAsync(0);
      expect(env.injected).toEqual([]);
    });

    it("an in-flight tick rejecting after restart is swallowed silently", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValueOnce(busy());
      await sync.sync("/a");
      const d = deferred<CwdSyncStatus>();
      env.status.mockReturnValue(d.promise);
      await vi.advanceTimersByTimeAsync(500);
      sync.reset();
      d.reject(new Error("killed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(env.errors).toEqual([]);
    });

    it("a stale tick cannot disturb a queue started after restart", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValueOnce(busy());
      await sync.sync("/a");
      const d = deferred<CwdSyncStatus>();
      env.status.mockReturnValueOnce(d.promise);
      await vi.advanceTimersByTimeAsync(500);
      sync.reset();
      env.status.mockResolvedValue(busy());
      await sync.sync("/a");
      expect(sync.state).toMatchObject({ kind: "queued", target: "/a" });
      d.resolve(idle());
      await vi.advanceTimersByTimeAsync(0);
      expect(env.injected).toEqual([]);
      expect(sync.state.kind).toBe("queued");
    });

    it("dispose cancels the timer and ignores late results", async () => {
      const { env, sync } = setup({ active: "/a" });
      env.status.mockResolvedValue(busy());
      await sync.sync("/a");
      sync.dispose();
      env.status.mockClear();
      await vi.advanceTimersByTimeAsync(3000);
      expect(env.status).not.toHaveBeenCalled();
      expect(sync.state.kind).toBe("idle");
    });
  });

  describe("following the explorer across shell starts (#1580)", () => {
    it("brings a shell that started during navigation to the explorer's current folder", async () => {
      const { env, sync } = setup({ id: null, active: "/old" });
      env.status.mockResolvedValue(idle(null));
      // The shell is (re)starting in /old when the explorer moves on.
      env.active = "/new";
      await sync.follow("/new");
      expect(env.injected).toEqual([]);

      env.id = 2;
      await sync.shellStarted("/old");
      expect(env.injected).toEqual(["/new"]);
      // The effect re-reporting the same path injects nothing more.
      await sync.follow("/new");
      expect(env.injected).toEqual(["/new"]);
    });

    it("writes no cd into a fresh shell that started where the explorer still is", async () => {
      const { env, sync } = setup({ id: 3, active: "/home/me/" });
      env.status.mockResolvedValue(idle(null));
      await sync.shellStarted("/home/me");
      expect(env.status).not.toHaveBeenCalled();
      expect(env.injected).toEqual([]);
    });

    it("a path followed while no shell ran is followed again after returning to it", async () => {
      // Restart in /a; navigate to /b during it; the new shell is reconciled
      // to /b. Navigating back to /a must cd again — the old dedupe still
      // remembered /a and skipped it, stranding the shell in /b.
      const { env, sync } = setup({ id: 1, active: "/a" });
      env.status.mockResolvedValue(idle(null));
      await sync.follow("/a");
      expect(env.injected).toEqual(["/a"]);
      sync.reset();
      env.id = null;
      env.active = "/b";
      await sync.follow("/b");
      env.id = 2;
      await sync.shellStarted("/a");
      env.active = "/a";
      await sync.follow("/a");
      expect(env.injected).toEqual(["/a", "/b", "/a"]);
    });

    it("leaves a new shell where it started while following is off, then follows once enabled", async () => {
      const { env, sync } = setup({ id: 4, active: "/b", follows: false });
      env.status.mockResolvedValue(idle(null));
      await sync.shellStarted("/a");
      expect(env.injected).toEqual([]);
      env.follows = true;
      await sync.follow("/b");
      expect(env.injected).toEqual(["/b"]);
    });

    it("queues behind a busy starting shell like any other sync", async () => {
      const { env, sync } = setup({ id: 5, active: "/new" });
      env.status.mockResolvedValue(busy(null));
      await sync.shellStarted("/old");
      expect(sync.state.kind).toBe("queued");
      expect(env.toasts).toBe(1);
      sync.dispose();
    });

    it("does not cd twice when navigation reaches the shell just before its start resolves", async () => {
      const { env, sync } = setup({ id: null, active: "/a" });
      env.status.mockResolvedValue(idle(null));
      // The shell is live (it has an id) but its start has not resolved yet.
      env.id = 7;
      env.active = "/b";
      await sync.follow("/b");
      expect(env.injected).toEqual(["/b"]);
      await sync.shellStarted("/a");
      expect(env.injected).toEqual(["/b"]);
    });

    it("ignores empty explorer paths", async () => {
      const { env, sync } = setup({ id: 6, active: "" });
      await sync.follow("");
      await sync.shellStarted("/old");
      expect(env.status).not.toHaveBeenCalled();
    });
  });
});
