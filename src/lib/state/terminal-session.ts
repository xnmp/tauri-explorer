import {
  createTerminalInputQueue,
  type TerminalInputReceipt,
} from "$lib/domain/terminal-input-queue";

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
  /** Write number `seq` of terminal `id`'s input stream (#882). */
  write(id: number, seq: number, data: string): Promise<TerminalInputReceipt>;
}

export interface TerminalSessionCallbacks {
  output(payload: string): void;
  cwd(payload: string): void;
  exit(): void;
  /** Input could not be delivered: a failed send or a failed queued read. */
  writeError(error: unknown): void;
  /** The backend discarded `bytes` of typeahead typed before the shell started. */
  inputDropped(bytes: number): void;
}

interface Acquisition {
  generation: number;
  id: number | null;
  unlisteners: TerminalSessionUnlisten[];
  spawned: boolean;
  /** The input stream this acquisition's shell will serve. */
  stream: InputStream;
}

/** One opening of the input queue, from `open` until it closes. */
interface InputStream {
  /** Settles with the spawn info once its shell runs, or null if none does. */
  running: Promise<TerminalSessionSpawnInfo | null>;
  settle(info: TerminalSessionSpawnInfo | null): void;
  closed: boolean;
}

function createInputStream(): InputStream {
  let resolve!: (info: TerminalSessionSpawnInfo | null) => void;
  const running = new Promise<TerminalSessionSpawnInfo | null>((done) => { resolve = done; });
  let settled = false;
  return {
    running,
    settle(info) {
      if (settled) return;
      settled = true;
      resolve(info);
    },
    closed: false,
  };
}

/** Builds inserted text for the shell that actually spawned. */
export type InsertionBuilder = (info: TerminalSessionSpawnInfo) => string;

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
  // The only path to the shell's input (#709, #882). Opened when a shell
  // starts, attached once it has an id, closed when it stops or exits.
  const input = createTerminalInputQueue({
    error: callbacks.writeError,
    dropped: callbacks.inputDropped,
  });
  let stream = createInputStream();
  closeInput();
  // Insertions requested while no shell runs or starts; the next shell gets
  // them first, quoted in its own dialect (#265, #409).
  const pendingInsertions: InsertionBuilder[] = [];

  /** Hold input for a shell that is starting; keeps an already-open stream. */
  function openInput(): InputStream {
    if (!stream.closed) return stream;
    stream = createInputStream();
    input.open();
    for (const build of pendingInsertions.splice(0)) insert(build);
    return stream;
  }

  /** No shell is coming for the current stream: drop its unsent input. */
  function closeInput(): void {
    stream.closed = true;
    stream.settle(null);
    input.close();
  }

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
    if (disposed || starting !== null) return null;
    // Typeahead from here on belongs to this shell (a no-op while a running
    // shell's stream is open).
    const opened = openInput();
    if (stopping !== null) await stopping;
    // A stop requested meanwhile closed this stream and cancels the start.
    if (disposed || current !== null || opened.closed) return null;

    const acquisition: Acquisition = {
      generation: ++generation,
      id: null,
      unlisteners: [],
      spawned: false,
      stream: opened,
    };
    current = acquisition;
    const operation = (async () => {
      try {
        acquisition.id = await dependencies.reserveId();
        requireCurrent(acquisition);
        const id = acquisition.id;
        // The backend holds input for a terminal that has not started yet.
        input.attach((seq, data) => dependencies.write(id, seq, data));
        acquisition.unlisteners.push(await dependencies.listenOutput(id, (payload) => {
          if (isCurrent(acquisition)) callbacks.output(payload);
        }));
        requireCurrent(acquisition);
        acquisition.unlisteners.push(await dependencies.listenExit(id, () => {
          if (!isCurrent(acquisition)) return;
          callbacks.exit();
          generation += 1;
          closeInput();
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
        acquisition.stream.settle(info);
        return info;
      } catch (error) {
        // A superseded start leaves the input to whoever superseded it.
        if (isCurrent(acquisition)) closeInput();
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
    // Even a stop joining one in progress cancels whatever started since.
    generation += 1;
    closeInput();
    if (stopping !== null) return stopping;
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

  /**
   * Replace the shell. Input written from this call on is typeahead for the
   * replacement; unsent input for the old shell is discarded.
   */
  async function restart(
    cwd: string | undefined,
    cols: number,
    rows: number,
  ): Promise<TerminalSessionSpawnInfo | null> {
    const stopped = stop();
    if (disposed) return null;
    const opened = openInput();
    await stopped;
    // A stop requested during the restart wins.
    if (opened.closed) return null;
    return start(cwd, cols, rows);
  }

  async function dispose(): Promise<void> {
    disposed = true;
    pendingInsertions.length = 0;
    closeInput();
    await stop();
  }

  /**
   * Queue input for the shell in call order. A promise holds its place until
   * it settles. Input is held while the shell starts and dropped while no
   * shell is running or starting.
   */
  function write(data: string | Promise<string>): void {
    if (!disposed) input.write(data);
  }

  /**
   * Queue text built for the shell that receives it, such as a path
   * insertion quoted in the spawned shell's dialect. It holds its place in
   * the input queue until that shell runs. With no shell running or starting,
   * it waits for the next one instead of being dropped.
   */
  function insert(build: InsertionBuilder): void {
    if (disposed) return;
    if (stream.closed) {
      pendingInsertions.push(build);
      return;
    }
    input.write(stream.running.then((info) => (info ? build(info) : "")));
  }

  return {
    get id(): number | null { return current?.spawned ? current.id : null; },
    get isDisposed(): boolean { return disposed; },
    start,
    stop,
    restart,
    dispose,
    write,
    insert,
  };
}

export type TerminalSession = ReturnType<typeof createTerminalSession>;
