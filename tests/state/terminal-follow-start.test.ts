/**
 * "Terminal follows explorer" across a shell (re)start (#1580), through the
 * real session and cwd-sync controller, wired the way TerminalPanel wires
 * them: the panel's path effect calls `follow`, and every spawn goes through
 * `startFollowingShell`. Only the PTY IPC is faked.
 */
import { describe, expect, it, vi } from "vitest";
import { createTerminalSession, type TerminalSessionSpawnInfo } from "$lib/state/terminal-session";
import { createTerminalCwdSync, startFollowingShell, type CwdSyncStatus } from "$lib/state/terminal-cwd-sync";

const POSIX: TerminalSessionSpawnInfo = { shellKind: "posix", wslDistro: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(initialPath: string) {
  let explorerPath = initialPath;
  let nextId = 0;
  const spawnCwds: Array<string | undefined> = [];
  const cds: string[] = [];
  const order: string[] = [];
  let holdSpawn: Promise<void> | null = null;
  const status = vi.fn<(id: number) => Promise<CwdSyncStatus>>(async () => ({ cwd: null, busy: false }));

  const session = createTerminalSession(
    {
      reserveId: async () => ++nextId,
      listenOutput: async () => () => {},
      listenExit: async () => () => {},
      listenCwd: async () => () => {},
      spawn: async (_id, cwd) => {
        spawnCwds.push(cwd);
        if (holdSpawn) await holdSpawn;
        return POSIX;
      },
      kill: async () => {},
      write: async () => ({ droppedBytes: 0 }),
    },
    { output() {}, exit() {}, cwd() {}, writeError() {}, inputDropped() {} },
  );

  const cwdSync = createTerminalCwdSync({
    sessionId: () => session.id,
    queryStatus: status,
    normalizeCwd: (raw) => raw,
    activePath: () => explorerPath,
    followsExplorer: () => true,
    injectCd: (path) => {
      order.push(`cd:${path}`);
      cds.push(path);
    },
    notifyQueued() {},
    reportError() {},
    scheduler: { every: () => () => {} },
  });

  /** TerminalPanel's spawnShell. */
  const spawnShell = (restart: boolean) =>
    startFollowingShell(
      cwdSync,
      explorerPath,
      (cwd) => (restart ? session.restart(cwd, 80, 24) : session.start(cwd, 80, 24)),
      () => order.push("ready"),
    );

  return {
    session,
    spawnCwds,
    cds,
    order,
    status,
    spawnShell,
    /** The explorer navigates; the panel's path effect re-runs. */
    async navigate(path: string) {
      explorerPath = path;
      await cwdSync.follow(path);
    },
    holdNextSpawn() {
      const gate = deferred<void>();
      holdSpawn = gate.promise;
      return () => {
        holdSpawn = null;
        gate.resolve();
      };
    },
    resetForRestart: () => cwdSync.reset(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("terminal follows explorer across shell starts (#1580)", () => {
  it("a restarted shell follows a navigation made while it was starting", async () => {
    const h = harness("/old");
    await h.navigate("/old");
    await h.spawnShell(false);
    expect(h.cds).toEqual([]);

    h.resetForRestart();
    const release = h.holdNextSpawn();
    const restarting = h.spawnShell(true);
    await vi.waitFor(() => expect(h.spawnCwds).toEqual(["/old", "/old"]));
    expect(h.session.id).toBeNull();

    await h.navigate("/new");
    expect(h.cds).toEqual([]);

    release();
    await restarting;
    await settle();
    expect(h.session.id).not.toBeNull();
    expect(h.cds).toEqual(["/new"]);
    // The cd is written in the spawned shell's dialect: after `ready`.
    expect(h.order).toEqual(["ready", "ready", "cd:/new"]);

    // Returning to the old folder is a real move for this shell.
    await h.navigate("/old");
    await settle();
    expect(h.cds).toEqual(["/new", "/old"]);
  });

  it("the first shell follows a navigation made while it was starting", async () => {
    const h = harness("/home");
    await h.navigate("/home");
    const release = h.holdNextSpawn();
    const starting = h.spawnShell(false);
    await vi.waitFor(() => expect(h.spawnCwds).toEqual(["/home"]));
    await h.navigate("/home/docs");
    release();
    await starting;
    await settle();
    expect(h.cds).toEqual(["/home/docs"]);
  });

  it("a shell that starts where the explorer still is gets no cd or status query", async () => {
    const h = harness("/home");
    await h.navigate("/home");
    await h.spawnShell(false);
    await settle();
    expect(h.cds).toEqual([]);
    expect(h.status).not.toHaveBeenCalled();
  });

  it("a failed status query after a start is reported, not thrown", async () => {
    const h = harness("/a");
    const release = h.holdNextSpawn();
    const starting = h.spawnShell(false);
    await vi.waitFor(() => expect(h.spawnCwds).toEqual(["/a"]));
    await h.navigate("/b");
    h.status.mockRejectedValueOnce(new Error("shell died"));
    release();
    await expect(starting).resolves.toEqual(POSIX);
    await settle();
    expect(h.cds).toEqual([]);
  });
});
