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
 */

import { decideCdSync, shouldFlushQueuedCd } from "$lib/domain/terminal-cwd-sync";

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

  return {
    async sync(path: string): Promise<void> {
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
    },
    shellExited: invalidate,
    reset: invalidate,
    dispose: invalidate,
    get state() {
      return state;
    },
  };
}
