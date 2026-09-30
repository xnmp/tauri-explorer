import { describe, expect, it, vi } from "vitest";
import {
  createTerminalInputQueue,
  type TerminalInputReceipt,
} from "$lib/domain/terminal-input-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/**
 * A stand-in for one PTY's `terminal_write`: every call stays in flight until
 * the test settles it, and it records what a sequence-ordered backend would
 * deliver.
 */
function backend() {
  const calls: { seq: number; data: string; ok(receipt?: TerminalInputReceipt): void; fail(error: unknown): void }[] = [];
  const bySeq = new Map<number, string>();
  const send = vi.fn((seq: number, data: string) => {
    const reply = deferred<TerminalInputReceipt>();
    let settled = false;
    calls.push({
      seq,
      data,
      ok: (receipt = { droppedBytes: 0 }) => {
        if (settled) return;
        settled = true;
        if (!bySeq.has(seq)) bySeq.set(seq, data);
        reply.resolve(receipt);
      },
      fail: (error) => {
        if (settled) return;
        settled = true;
        reply.reject(error);
      },
    });
    return reply.promise;
  });
  /** Settle every outstanding call successfully until none remain. */
  const drain = async () => {
    for (let index = 0; index < calls.length; index++) {
      calls[index].ok();
      await settle();
    }
  };
  const delivered = () => [...bySeq.keys()].sort((a, b) => a - b).map((seq) => bySeq.get(seq)).join("");
  return { calls, send, drain, delivered };
}

function queue() {
  const events = { error: vi.fn(), dropped: vi.fn() };
  return { events, input: createTerminalInputQueue(events) };
}

describe("terminal input queue", () => {
  it("holds typeahead until the terminal has an id, then sends it first", async () => {
    const { input } = queue();
    const pty = backend();
    input.open();
    input.write("ec");
    input.write("ho");
    expect(pty.send).not.toHaveBeenCalled();
    input.attach(pty.send);
    input.write(" hi\r");
    await pty.drain();
    expect(pty.delivered()).toBe("echo hi\r");
    expect(pty.calls.map((call) => call.seq)).toEqual([0, 1]);
  });

  it("keeps later keystrokes behind a pending paste, even when the paste settles last", async () => {
    const { input } = queue();
    const pty = backend();
    input.open();
    input.attach(pty.send);
    const firstPaste = deferred<string>();
    const secondPaste = deferred<string>();
    input.write("a");
    input.write(firstPaste.promise);
    input.write(secondPaste.promise);
    input.write("\r");
    secondPaste.resolve("second");
    await pty.drain();
    expect(pty.delivered()).toBe("a");
    firstPaste.resolve("first ");
    await settle();
    await pty.drain();
    expect(pty.delivered()).toBe("afirst second\r");
  });

  it("orders programmatic insertions, pastes and keystrokes by write call, not by resolution", async () => {
    const { input } = queue();
    const pty = backend();
    input.open();
    const insertion = deferred<string>();
    const paste = deferred<string>();
    input.write(insertion.promise);
    input.write(" ");
    input.write(paste.promise);
    input.write("\r");
    input.attach(pty.send);
    paste.resolve("pasted");
    insertion.resolve("'/tmp/a b'");
    await settle();
    await pty.drain();
    expect(pty.delivered()).toBe("'/tmp/a b' pasted\r");
  });

  it("coalesces input behind one in-flight send and numbers sends consecutively", async () => {
    const { input } = queue();
    const pty = backend();
    input.open();
    input.attach(pty.send);
    for (const character of "print") input.write(character);
    expect(pty.calls.map(({ seq, data }) => [seq, data])).toEqual([[0, "p"]]);
    await pty.drain();
    expect(pty.calls.map(({ seq, data }) => [seq, data])).toEqual([[0, "p"], [1, "rint"]]);
  });

  it("reuses a failed send's number so the backend is never left waiting for it", async () => {
    const { input, events } = queue();
    const pty = backend();
    input.open();
    input.attach(pty.send);
    input.write("lost");
    const failure = new Error("ipc failed");
    pty.calls[0].fail(failure);
    await settle();
    input.write("next");
    await pty.drain();
    expect(events.error).toHaveBeenCalledWith(failure);
    expect(pty.calls.map(({ seq, data }) => [seq, data])).toEqual([[0, "lost"], [0, "next"]]);
    expect(pty.delivered()).toBe("next");
  });

  it("resends under the next number when a reused number turns out to be spent", async () => {
    const { input, events } = queue();
    const send = vi.fn(async (seq: number, data: string): Promise<TerminalInputReceipt> => {
      if (seq === 0 && data === "first") throw new Error("reply lost after the backend admitted it");
      return seq === 0 ? { droppedBytes: 0, duplicate: true } : { droppedBytes: 0 };
    });
    input.open();
    input.attach(send);
    input.write("first");
    await settle();
    input.write("second");
    await settle();
    input.write("third");
    await settle();
    expect(send.mock.calls).toEqual([[0, "first"], [0, "second"], [1, "second"], [2, "third"]]);
    expect(events.error).toHaveBeenCalledOnce();
  });

  it("keeps resending while reused numbers come back spent", async () => {
    const { input, events } = queue();
    const send = vi.fn(async (seq: number): Promise<TerminalInputReceipt> =>
      seq < 2 ? { droppedBytes: 0, duplicate: true } : { droppedBytes: 0 });
    input.open();
    input.attach(send);
    input.write("data");
    await settle();
    input.write("next");
    await settle();
    expect(send.mock.calls).toEqual([[0, "data"], [1, "data"], [2, "data"], [3, "next"]]);
    expect(events.error).not.toHaveBeenCalled();
  });

  it("reports a write the backend declared lost without resending it", async () => {
    const { input, events } = queue();
    const send = vi.fn(async (seq: number): Promise<TerminalInputReceipt> =>
      seq === 0 ? { droppedBytes: 0, lost: true } : { droppedBytes: 0 });
    input.open();
    input.attach(send);
    input.write("late");
    await settle();
    input.write("next");
    await settle();
    expect(send.mock.calls).toEqual([[0, "late"], [1, "next"]]);
    expect(events.error).toHaveBeenCalledOnce();
  });

  it("discards an attached stream's queued input when a new stream opens", async () => {
    const { input } = queue();
    const first = backend();
    input.open();
    input.attach(first.send);
    input.write("sent");
    input.write("queued behind the in-flight send");
    const pending = deferred<string>();
    input.write(pending.promise);
    input.open();
    input.write("new stream");
    const second = backend();
    input.attach(second.send);
    pending.resolve("stale paste");
    await settle();
    await first.drain();
    await second.drain();
    expect(first.delivered()).toBe("sent");
    expect(second.delivered()).toBe("new stream");
  });

  it("does not report a send that fails after its stream closed", async () => {
    const { input, events } = queue();
    const pty = backend();
    input.open();
    input.attach(pty.send);
    input.write("racing exit");
    input.close();
    pty.calls[0].fail(new Error("terminal 41 is closing"));
    await settle();
    expect(events.error).not.toHaveBeenCalled();
  });

  it("reports typeahead the backend discarded", async () => {
    const { input, events } = queue();
    const pty = backend();
    input.open();
    input.write("x".repeat(10));
    input.attach(pty.send);
    pty.calls[0].ok({ droppedBytes: 10 });
    await settle();
    input.write("y");
    pty.calls[1].ok({ droppedBytes: 1 });
    await settle();
    expect(events.dropped.mock.calls).toEqual([[10, true], [1, false]]);
  });

  it("releases later input when a queued read fails, and reports the failure", async () => {
    const { input, events } = queue();
    const pty = backend();
    input.open();
    input.attach(pty.send);
    const failure = new Error("clipboard denied");
    input.write(Promise.reject(failure));
    input.write("after");
    await settle();
    await pty.drain();
    expect(pty.delivered()).toBe("after");
    expect(events.error).toHaveBeenCalledWith(failure);
  });

  it("drops input while no shell is running or starting", async () => {
    const { input } = queue();
    const pty = backend();
    input.write("before open");
    input.open();
    input.attach(pty.send);
    input.write("live");
    input.close();
    input.write("after close");
    await pty.drain();
    expect(pty.delivered()).toBe("live");
  });

  it("never delivers a closed stream's unsent input to the next stream", async () => {
    const { input, events } = queue();
    const first = backend();
    input.open();
    input.attach(first.send);
    input.write("sent");
    input.write("unsent");
    const stalePaste = deferred<string>();
    const staleRead = deferred<string>();
    input.write(stalePaste.promise);
    input.write(staleRead.promise);
    input.close();

    const second = backend();
    input.open();
    input.write("fresh");
    input.attach(second.send);
    stalePaste.resolve("stale");
    staleRead.reject(new Error("late failure"));
    await first.drain();
    await second.drain();
    expect(first.delivered()).toBe("sent");
    expect(second.delivered()).toBe("fresh");
    expect(second.calls[0].seq).toBe(0);
    expect(events.error).not.toHaveBeenCalled();
  });

  it("keeps held typeahead when a starting shell reopens the stream", async () => {
    const { input } = queue();
    const pty = backend();
    input.open();
    input.write("typed during restart");
    input.open();
    input.attach(pty.send);
    await pty.drain();
    expect(pty.delivered()).toBe("typed during restart");
  });

  it("ignores attach unless a stream is waiting for one", async () => {
    const { input } = queue();
    const pty = backend();
    input.attach(pty.send);
    input.write("closed");
    input.open();
    input.attach(pty.send);
    const other = backend();
    input.attach(other.send);
    input.write("x");
    await pty.drain();
    expect(pty.delivered()).toBe("x");
    expect(other.send).not.toHaveBeenCalled();
  });

  it("delivers a very large paste whole once the shell is attached", async () => {
    const { input } = queue();
    const pty = backend();
    input.open();
    input.attach(pty.send);
    const big = "y".repeat(1_000_000);
    input.write(Promise.resolve(big));
    input.write("\r");
    await settle();
    await pty.drain();
    expect(pty.delivered()).toBe(`${big}\r`);
  });

  it("treats a non-string resolution as empty input", async () => {
    const { input } = queue();
    const pty = backend();
    input.open();
    input.attach(pty.send);
    input.write(Promise.resolve(undefined as unknown as string));
    input.write("ok");
    await settle();
    await pty.drain();
    expect(pty.delivered()).toBe("ok");
  });
});
