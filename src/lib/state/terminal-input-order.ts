/**
 * Keeps an asynchronous clipboard read in the terminal input position where
 * Paste was pressed. xterm's paste() synchronously emits the correct bytes,
 * including bracketed-paste markers when the shell requested them.
 */
export function createTerminalInputOrder(writeToSession: (data: string) => void) {
  type Entry = { ready: boolean; data: string };
  const entries: Entry[] = [];
  let capture: string[] | null = null;
  let closed = false;

  function flush(): void {
    while (!closed && entries[0]?.ready) {
      const entry = entries.shift()!;
      if (entry.data) writeToSession(entry.data);
    }
  }

  function write(data: string): void {
    if (closed || !data) return;
    if (capture) {
      capture.push(data);
      return;
    }
    entries.push({ ready: true, data });
    flush();
  }

  function paste(read: Promise<string>, emitPaste: (text: string) => void, onError: (error: unknown) => void): void {
    if (closed) return;
    const entry: Entry = { ready: false, data: "" };
    entries.push(entry);
    void read.then((text) => {
      if (closed) return;
      capture = [];
      try {
        if (text) emitPaste(text);
        entry.data = capture.join("");
      } catch (error) {
        report(error);
      } finally {
        capture = null;
        entry.ready = true;
        flush();
      }
    }, (error) => {
      if (closed) return;
      report(error);
      entry.ready = true;
      flush();
    });

    function report(error: unknown): void {
      try { onError(error); } catch { /* A failing reporter must not strand input. */ }
    }
  }

  function close(): void {
    closed = true;
    entries.length = 0;
    capture = null;
  }

  return { write, paste, close };
}
