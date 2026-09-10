export type TerminalSessionUnlisten = () => void;

export interface TerminalSessionSpawnInfo {
  shellKind: "posix" | "powershell" | "cmd";
  wslDistro: string | null;
}

export interface TerminalSessionDependencies {
  reserveId(): Promise<number>;
  listenOutput(id: number, handler: (payload: string) => void): Promise<TerminalSessionUnlisten>;
  listenExit(id: number, handler: () => void): Promise<TerminalSessionUnlisten>;
  listenCwd(id: number, handler: (payload: string) => void): Promise<TerminalSessionUnlisten>;
  spawn(id: number, cwd: string | undefined, cols: number, rows: number): Promise<TerminalSessionSpawnInfo>;
  kill(id: number): Promise<void>;
}

export interface TerminalSessionCallbacks {
  output(payload: string): void;
  cwd(payload: string): void;
  exit(): void;
}

interface Acquisition {
  generation: number;
  id: number | null;
  unlisteners: TerminalSessionUnlisten[];
  spawned: boolean;
}

const cancelled = Symbol("terminal-session-cancelled");

/** Owns the complete async lifetime of one frontend terminal session. */
export function createTerminalSession(
  dependencies: TerminalSessionDependencies,
  callbacks: TerminalSessionCallbacks,
) {
  let generation = 0;
  let disposed = false;
  let current: Acquisition | null = null;
  let starting: Promise<TerminalSessionSpawnInfo | null> | null = null;
  let stopping: Promise<void> | null = null;

  const isCurrent = (acquisition: Acquisition): boolean =>
    !disposed && acquisition.generation === generation;

  const requireCurrent = (acquisition: Acquisition): void => {
    if (!isCurrent(acquisition)) throw cancelled;
  };

  async function release(acquisition: Acquisition, kill: boolean): Promise<void> {
    for (const unlisten of acquisition.unlisteners.splice(0).reverse()) {
      try {
        unlisten();
      } catch {
        // One broken event cleanup must not strand the other listeners or PTY.
      }
    }
    const id = acquisition.id;
    acquisition.id = null;
    if (kill && id !== null) {
      try {
        await dependencies.kill(id);
      } catch {
        // The process may already have exited; listener cleanup must still finish.
      }
    }
    if (current === acquisition) current = null;
  }

  async function start(
    cwd: string | undefined,
    cols: number,
    rows: number,
  ): Promise<TerminalSessionSpawnInfo | null> {
    if (disposed || current !== null || starting !== null) return null;
    if (stopping !== null) await stopping;
    if (disposed || current !== null) return null;

    const acquisition: Acquisition = {
      generation: ++generation,
      id: null,
      unlisteners: [],
      spawned: false,
    };
    current = acquisition;
    const operation = (async () => {
      try {
        acquisition.id = await dependencies.reserveId();
        requireCurrent(acquisition);
        const id = acquisition.id;
        acquisition.unlisteners.push(await dependencies.listenOutput(id, (payload) => {
          if (isCurrent(acquisition)) callbacks.output(payload);
        }));
        requireCurrent(acquisition);
        acquisition.unlisteners.push(await dependencies.listenExit(id, () => {
          if (!isCurrent(acquisition)) return;
          callbacks.exit();
          generation += 1;
          void release(acquisition, false);
        }));
        requireCurrent(acquisition);
        acquisition.unlisteners.push(await dependencies.listenCwd(id, (payload) => {
          if (isCurrent(acquisition)) callbacks.cwd(payload);
        }));
        requireCurrent(acquisition);
        const info = await dependencies.spawn(id, cwd, cols, rows);
        acquisition.spawned = true;
        requireCurrent(acquisition);
        return info;
      } catch (error) {
        await release(acquisition, acquisition.id !== null);
        if (error === cancelled) return null;
        throw error;
      }
    })();
    starting = operation;
    try {
      return await operation;
    } finally {
      if (starting === operation) starting = null;
    }
  }

  async function stop(): Promise<void> {
    if (stopping !== null) return stopping;
    generation += 1;
    const acquisition = current;
    const operation = (async () => {
      if (starting !== null) await starting.catch(() => undefined);
      if (acquisition !== null) await release(acquisition, true);
    })();
    stopping = operation;
    try {
      await operation;
    } finally {
      if (stopping === operation) stopping = null;
    }
  }

  async function dispose(): Promise<void> {
    disposed = true;
    await stop();
  }

  return {
    get id(): number | null { return current?.spawned ? current.id : null; },
    get isDisposed(): boolean { return disposed; },
    start,
    stop,
    dispose,
  };
}

export type TerminalSession = ReturnType<typeof createTerminalSession>;
