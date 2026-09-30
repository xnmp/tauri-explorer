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
 *    succeeded, so a failed send never leaves the backend waiting for it (and
 *    a reused number the backend had in fact admitted is reported as a
 *    duplicate, whose data is resent under the next number).
 *
 * Lifecycle: `open` begins a stream for a shell that is starting, `attach`
 * connects it to that terminal's id, and `close` ends it. Unsent input from a
 * previous stream is discarded rather than delivered to its successor (#709),
 * and input written while no shell is running or starting is dropped.
 */
import { createOrderedWriter, type OrderedWriter } from "./ordered-writer";

export interface TerminalInputReceipt {
  /** Typeahead the backend discarded because its bounded buffer overflowed.
   *  An overflow discards all pre-start input, including what was held. */
  droppedBytes: number;
  /** The sequence number was already admitted, so this data was ignored. */
  duplicate?: boolean;
  /** The sequence number fell in a gap the backend declared lost, so this
   *  data was ignored; resending it would reorder the stream. */
  lost?: boolean;
}

/** Deliver write number `seq` of the current stream to its PTY. */
export type TerminalInputSend = (seq: number, data: string) => Promise<TerminalInputReceipt>;

export interface TerminalInputQueueEvents {
  /** A send or a queued asynchronous input failed; it contributes nothing. */
  error(error: unknown): void;
  /** The backend discarded `bytes` of typeahead typed before the shell
   *  started. `firstInStream` is true for the stream's first report. */
  dropped(bytes: number, firstInStream: boolean): void;
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
      let droppedBefore = false;
      const stream: OrderedWriter = createOrderedWriter(async (data) => {
        let receipt = await send(seq, data);
        // A failed send's number is reused, so the backend never waits on a
        // write that did not arrive. If the failure hid a write the backend
        // did admit, the reused number comes back as a duplicate: resend
        // under the next one, for as long as numbers keep coming back spent.
        while (receipt?.duplicate) {
          seq += 1;
          receipt = await send(seq, data);
        }
        seq += 1;
        if (receipt?.lost) {
          throw new Error(`terminal input write ${seq - 1} arrived after the backend declared it lost`);
        }
        const dropped = receipt?.droppedBytes ?? 0;
        if (dropped > 0) {
          const first = !droppedBefore;
          droppedBefore = true;
          report(() => events.dropped(dropped, first));
        }
      }, (error) => {
        // A send that raced the stream's close (the shell exited or was
        // killed) is expected to fail; only a live stream's failure matters.
        if (writer === stream) events.error(error);
      });
      writer = stream;
      state = "attached";
      flush();
    },
    close() {
      discard();
      state = "closed";
    },
  };
}
