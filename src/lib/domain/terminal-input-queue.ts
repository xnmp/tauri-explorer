/**
 * The one input queue in front of a terminal's PTY (#882).
 *
 * Everything the shell receives passes through `write`, in call order:
 * keystrokes, shortcut sequences, pastes, path insertions and injected `cd`s.
 * Input that is not known yet (a clipboard read, an insertion that needs the
 * spawned shell's dialect) is written as a promise and holds its place until
 * it settles, so later keystrokes can never overtake it.
 *
 * The backend owns ordering past this point: every send carries the stream's
 * sequence number, and `terminal_write` admits writes in that order whatever
 * order the IPC calls run in. It also holds (bounded) typeahead until the
 * shell starts. This queue therefore only has to
 *  - hold input until the terminal has an id (`attach`, one IPC round trip
 *    after `open`),
 *  - sequence asynchronous input with synchronous input, and
 *  - coalesce keystrokes behind one in-flight send, which bounds IPC traffic
 *    and keeps the sequence gap-free: a number is used up only by a send that
 *    succeeded, so a failed send never leaves the backend waiting for it.
 *
 * Lifecycle: `open` begins a stream for a shell that is starting, `attach`
 * connects it to that terminal's id, and `close` ends it. Unsent input from a
 * previous stream is discarded rather than delivered to its successor (#709),
 * and input written while no shell is running or starting is dropped.
 */
import { createOrderedWriter, type OrderedWriter } from "./ordered-writer";

export interface TerminalInputReceipt {
  /** Typeahead the backend discarded because its bounded buffer was full. */
  droppedBytes: number;
}

/** Deliver write number `seq` of the current stream to its PTY. */
export type TerminalInputSend = (seq: number, data: string) => Promise<TerminalInputReceipt>;

export interface TerminalInputQueueEvents {
  /** A send or a queued asynchronous input failed; it contributes nothing. */
  error(error: unknown): void;
  /** The backend discarded `bytes` of typeahead typed before the shell started. */
  dropped(bytes: number): void;
}

export interface TerminalInputQueue {
  /** Queue input after everything written before it. */
  write(data: string | Promise<string>): void;
  /** Start holding input for a shell that is starting. Keeps input already
   *  held for it; discards an attached stream's unsent input. */
  open(): void;
  /** Send held and future input through `send`, numbered from 0. */
  attach(send: TerminalInputSend): void;
  /** Discard unsent input and drop further input until the next `open`. */
  close(): void;
}

interface Entry {
  /** Null until an asynchronous input settles. */
  data: string | null;
}

export function createTerminalInputQueue(events: TerminalInputQueueEvents): TerminalInputQueue {
  let state: "closed" | "holding" | "attached" = "closed";
  // Replaced, never cleared in place: a settling promise compares its
  // stream's array with the current one to learn whether it is stale.
  let entries: Entry[] = [];
  let writer: OrderedWriter | null = null;

  function report(notify: () => void): void {
    try {
      notify();
    } catch {
      // A failing reporter must not strand the stream.
    }
  }

  function flush(): void {
    if (writer === null) return;
    while (entries.length > 0 && entries[0].data !== null) {
      const { data } = entries.shift()!;
      if (data) writer.write(data);
    }
  }

  function discard(): void {
    entries = [];
    writer?.close();
    writer = null;
  }

  function writeLater(pending: Promise<string>): void {
    const entry: Entry = { data: null };
    const stream = entries;
    stream.push(entry);
    const settle = (data: string) => {
      if (entries !== stream) return;
      entry.data = data;
      flush();
    };
    pending.then(
      (data) => settle(typeof data === "string" ? data : ""),
      (error) => {
        if (entries !== stream) return;
        report(() => events.error(error));
        settle("");
      },
    );
  }

  return {
    write(data) {
      if (state === "closed") return;
      if (typeof data !== "string") {
        writeLater(data);
        return;
      }
      if (data === "") return;
      entries.push({ data });
      flush();
    },
    open() {
      if (state === "holding") return;
      discard();
      state = "holding";
    },
    attach(send) {
      if (state !== "holding") return;
      let seq = 0;
      writer = createOrderedWriter(async (data) => {
        const receipt = await send(seq, data);
        // Advanced only on success: a failed write's number is reused, so the
        // backend never waits on a write that did not arrive.
        seq += 1;
        const dropped = receipt?.droppedBytes ?? 0;
        if (dropped > 0) report(() => events.dropped(dropped));
      }, events.error);
      state = "attached";
      flush();
    },
    close() {
      discard();
      state = "closed";
    },
  };
}
