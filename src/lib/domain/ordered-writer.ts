/**
 * An ordered byte stream over a transport that does not preserve call order.
 *
 * Separate Tauri invocations can complete in any order: `terminal_write` runs
 * each call on the blocking pool, so two adjacent keystrokes sent as two
 * concurrent invocations could reach the PTY transposed (#709). The writer
 * keeps at most one send in flight and coalesces everything written meanwhile
 * into the next send, so a later chunk can never overtake an earlier one.
 * A stalled sink applies backpressure to this buffer instead of occupying one
 * backend thread per keystroke.
 */
export interface OrderedWriter {
  /** Queue `data` after everything written before it. Ignored once closed. */
  write(data: string): void;
  /** Drop unsent data and refuse further writes; an in-flight send finishes. */
  close(): void;
}

export function createOrderedWriter(
  send: (data: string) => Promise<void>,
  onError: (error: unknown) => void,
): OrderedWriter {
  let pending = "";
  let inFlight = false;
  let closed = false;

  function pump(): void {
    if (inFlight || closed || pending === "") return;
    const batch = pending;
    pending = "";
    inFlight = true;
    let sent: Promise<void>;
    try {
      sent = send(batch);
    } catch (error) {
      sent = Promise.reject(error);
    }
    // One failed batch must not wedge the stream; its data is lost, exactly
    // as a failed PTY write loses it. Clearing the flag and pumping happen in
    // the same callback, so data written while this batch was in flight is
    // never stranded behind a writer that believes a send is still running.
    sent.then(undefined, report).then(() => {
      inFlight = false;
      pump();
    });
  }

  function report(error: unknown): void {
    try {
      onError(error);
    } catch {
      // A throwing reporter must not stop the stream either.
    }
  }

  return {
    write(data) {
      if (closed || data === "") return;
      pending += data;
      pump();
    },
    close() {
      closed = true;
      pending = "";
    },
  };
}
