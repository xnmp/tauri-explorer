/**
 * "Terminal follows explorer" cwd sync controller (#149, #154, #266, #1566).
 *
 * Owns the whole queue/poll/re-entrancy machine that used to live in
 * TerminalPanel as loose flags. State is ONE discriminated union:
 *
 *   idle                         nothing deferred
 *   queued{target, checking}     a cd is deferred behind a busy foreground
 *                                command; a poll timer runs. `checking` is the
 *                                re-entrancy guard for the poll's async status
 *                                query. Being `queued` IS "toast already shown"
 *                                (the toast fires on entering the state).
 *
 * Transitions (E = event):
 *   idle   --sync: shell busy, not at target-->        queued (toast once, start timer)
 *   queued --sync: busy again-->                       queued (target replaced, no toast)
 *   *      --sync: idle shell / already there-->       unchanged (write or skip)
 *   queued --tick, checking-->                         unchanged (tick ignored)
 *   queued --tick, still busy-->                       queued
 *   queued --tick, idle-->                             idle (write iff shouldFlushQueuedCd)
 *   queued --tick, status rejects / no session-->      idle (timer stopped)
 *   *      --exit / reset(restart) / dispose-->        idle, epoch bumped: any
 *                                                      in-flight status query resolves
 *                                                      into nothing
 *
 * Every async continuation re-checks `epoch`, so a late status result can never
 * write to (or queue against) a dead or replaced shell.
 *
 * Following (#1580): `follow` is fed every explorer path the panel observes
 * and syncs each new one; while no shell runs there is nothing to sync, but
 * the path is still the latest one requested. A shell spawns in the path read
 * when it was requested, so `shellStarted` reconciles it once against the
 * live explorer path — navigation during a (re)start would otherwise leave
 * the new shell in the old folder, with no later path change to correct it.
 */

import { decideCdSync, shouldFlushQueuedCd } from "$lib/domain/terminal-cwd-sync";
import { sameDirectory } from "$lib/domain/path";

export interface CwdSyncStatus {
  cwd: string | null;
  busy: boolean;
}

export interface CwdSyncScheduler {
  /** Run `fn` every `ms` until the returned cancel function is called. */
  every(ms: number, fn: () => void): () => void;
}

export interface CwdSyncDependencies {
  /** Live terminal session id, or null when no shell runs. */
  sessionId(): number | null;
  queryStatus(id: number): Promise<CwdSyncStatus>;
  /** Raw shell-reported cwd -> explorer path form. */
  normalizeCwd(raw: string): string;
  /** The active explorer's current path. */
  activePath(): string | undefined;
  /** Whether the "terminal follows explorer" setting is on. */
  followsExplorer(): boolean;
  /** Inject a `cd` to `path` (records the expected echo and writes it). */
  injectCd(path: string): void;
  /** Informational toast. */
  notifyQueued(): void;
  /** Log a swallowed failure. */
  reportError(message: string, err: unknown): void;
  scheduler: CwdSyncScheduler;
  pollIntervalMs?: number;
}

export type CwdSyncState =
  | { kind: "idle" }
  | { kind: "queued"; target: string; checking: boolean; cancelTimer: () => void };

export interface TerminalCwdSync {
  /** Reconcile the shell's cwd with `path`. Rejects if the status query does. */
  sync(path: string): Promise<void>;
  /**
   * The followed explorer moved to (or re-reported) `path`: sync it unless it
   * is the path last followed, so repeated reports of one path (any settings
   * change re-runs the panel's effect, #409) inject at most one cd.
   */
  follow(path: string): Promise<void>;
  /**
   * A shell finished spawning in `spawnCwd`: bring it to the explorer's
   * current path if the explorer moved meanwhile (#1580). Never rejects; a
   * failed status query is reported through `reportError`.
   */
  shellStarted(spawnCwd: string | undefined): Promise<void>;
  /** The shell exited: drop any deferred cd. */
  shellExited(): void;
  /** A replacement shell is being started: forget everything about the old one. */
  reset(): void;
  dispose(): void;
  readonly state: CwdSyncState;
}

export function createTerminalCwdSync(deps: CwdSyncDependencies): TerminalCwdSync {
  const pollMs = deps.pollIntervalMs ?? 500;
  let state: CwdSyncState = { kind: "idle" };
  let epoch = 0;
  // The path last followed, and the shell that was live when it was synced
  // (null: none was, so the next shell still needs it).
  let lastFollowed: { path: string; session: number | null } | null = null;

  const toIdle = (): void => {
    if (state.kind === "queued") state.cancelTimer();
    state = { kind: "idle" };
  };

  const invalidate = (): void => {
    epoch++;
    toIdle();
  };

  const statusCwdOf = (status: CwdSyncStatus): string | null =>
    status.cwd !== null ? deps.normalizeCwd(status.cwd) : null;

  function write(path: string): void {
    // Never inject `cd 'null'` / `cd ''` (#154).
    if (deps.sessionId() === null || path == null || path === "") return;
    deps.injectCd(path);
  }

  function queue(path: string): void {
    if (state.kind === "queued") {
      state = { ...state, target: path };
      return;
    }
    deps.notifyQueued();
    state = { kind: "queued", target: path, checking: false, cancelTimer: deps.scheduler.every(pollMs, () => void tick()) };
  }

  async function tick(): Promise<void> {
    const s = state;
    if (s.kind !== "queued" || s.checking) return;
    const id = deps.sessionId();
    if (id === null) {
      toIdle();
      return;
    }
    const myEpoch = epoch;
    state = { ...s, checking: true };
    // Identity of this queue episode: its cancel function.
    const episode = s.cancelTimer;
    const stillMine = (): boolean => myEpoch === epoch && state.kind === "queued" && state.cancelTimer === episode;
    try {
      const status = await deps.queryStatus(id);
      if (!stillMine()) return;
      const statusCwd = statusCwdOf(status);
      if (status.busy) {
        state = { ...(state as Extract<CwdSyncState, { kind: "queued" }>), checking: false };
        return;
      }
      // Latest target wins: sync() may have replaced it while we awaited.
      const target = (state as Extract<CwdSyncState, { kind: "queued" }>).target;
      toIdle();
      if (shouldFlushQueuedCd(target, deps.activePath(), statusCwd)) write(target);
    } catch (err) {
      if (!stillMine()) return;
      // Status rejected (e.g. terminal died before its exit event): stop
      // polling rather than spin on the rejection every tick.
      deps.reportError("cd queue poll failed; stopping poll", err);
      toIdle();
    }
  }

  async function sync(path: string): Promise<void> {
    if (path == null || path === "") return;
    const id = deps.sessionId();
    if (id === null) return;
    const myEpoch = epoch;
    const status = await deps.queryStatus(id);
    if (myEpoch !== epoch) return;
    const statusCwd = statusCwdOf(status);
    // Fast tab switches: latest target wins; a stale cd would drag the
    // shell (and, via its echo, the new tab) to the old directory (#266).
    if (deps.activePath() !== path) return;
    switch (decideCdSync(path, statusCwd, status.busy)) {
      case "skip":
        return;
      case "write":
        write(path);
        return;
      case "queue":
        queue(path);
        return;
    }
  }

  return {
    sync,
    follow(path: string): Promise<void> {
      if (path == null || path === "" || path === lastFollowed?.path) return Promise.resolve();
      lastFollowed = { path, session: deps.sessionId() };
      return sync(path);
    },
    shellStarted(spawnCwd: string | undefined): Promise<void> {
      const path = deps.activePath();
      const session = deps.sessionId();
      if (!deps.followsExplorer() || path == null || path === "") {
        // Not following: the new shell sits where it spawned, so turning
        // following on later must sync any other path.
        lastFollowed = spawnCwd ? { path: spawnCwd, session } : null;
        return Promise.resolve();
      }
      // The shell goes live a moment before its start resolves; a navigation
      // in between already synced this path to this shell.
      if (session !== null && lastFollowed?.path === path && lastFollowed.session === session) return Promise.resolve();
      lastFollowed = { path, session };
      // Still where it spawned: a fresh shell needs no cd (and has reported no
      // cwd yet, so a status query could not prove that).
      if (spawnCwd != null && spawnCwd !== "" && sameDirectory(path, spawnCwd)) return Promise.resolve();
      return sync(path).catch((err) => deps.reportError("sync after shell start failed", err));
    },
    shellExited: invalidate,
    reset: invalidate,
    dispose: invalidate,
    get state() {
      return state;
    },
  };
}

/**
 * Start (or restart) a shell in `cwd`, the explorer path read when the start
 * was requested, and keep it following the explorer (#1580). `ready` runs
 * first with the spawned shell's info (the cd dialect depends on it); then
 * the shell is reconciled with wherever the explorer moved during the spawn.
 */
export async function startFollowingShell<Info>(
  sync: Pick<TerminalCwdSync, "shellStarted">,
  cwd: string | undefined,
  begin: (cwd: string | undefined) => Promise<Info | null>,
  ready: (info: Info) => void,
): Promise<Info | null> {
  const info = await begin(cwd);
  if (info === null) return null;
  ready(info);
  void sync.shellStarted(cwd);
  return info;
}
