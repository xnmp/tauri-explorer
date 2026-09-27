import { describe, expect, it, vi } from "vitest";
import { createOrderedWriter } from "$lib/domain/ordered-writer";

/** A transport whose calls complete only when the test settles them, in any order. */
function manualTransport() {
  const calls: { data: string; resolve(): void; reject(error: unknown): void }[] = [];
  const delivered: string[] = [];
  const send = vi.fn((data: string) =>
    new Promise<void>((resolve, reject) => {
      calls.push({
        data,
        resolve: () => {
          delivered.push(data);
          resolve();
        },
        reject,
      });
    }),
  );
  return { calls, delivered, send };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("ordered writer", () => {
  it("sends the first write immediately", () => {
    const transport = manualTransport();
    const writer = createOrderedWriter(transport.send, vi.fn());
    writer.write("a");
    expect(transport.send).toHaveBeenCalledWith("a");
  });

  it("never lets a later write overtake an earlier one", async () => {
    // Before #709 each keystroke was its own concurrent invocation; resolving
    // the second first delivered "ba".
    const transport = manualTransport();
    const writer = createOrderedWriter(transport.send, vi.fn());
    writer.write("p");
    writer.write("r");
    writer.write("i");
    expect(transport.calls).toHaveLength(1);
    transport.calls[0].resolve();
    await settle();
    expect(transport.calls).toHaveLength(2);
    transport.calls[1].resolve();
    await settle();
    expect(transport.delivered.join("")).toBe("pri");
  });

  it("coalesces everything written during a send into the next send", async () => {
    const transport = manualTransport();
    const writer = createOrderedWriter(transport.send, vi.fn());
    writer.write("print");
    for (const character of "(1)\r") writer.write(character);
    transport.calls[0].resolve();
    await settle();
    expect(transport.calls.map((call) => call.data)).toEqual(["print", "(1)\r"]);
  });

  it("delivers data written between a send completing and the next pump", async () => {
    const transport = manualTransport();
    const writer = createOrderedWriter(transport.send, vi.fn());
    writer.write("a");
    const first = transport.calls[0];
    // Queue a write on the same microtask turn that settles the send.
    Promise.resolve().then(() => writer.write("b"));
    first.resolve();
    await settle();
    transport.calls[1]?.resolve();
    await settle();
    expect(transport.delivered).toEqual(["a", "b"]);
  });

  it("keeps later writes flowing after a failed send and reports the failure", async () => {
    const transport = manualTransport();
    const onError = vi.fn();
    const writer = createOrderedWriter(transport.send, onError);
    writer.write("lost");
    writer.write("kept");
    const failure = new Error("pty write failed");
    transport.calls[0].reject(failure);
    await settle();
    transport.calls[1].resolve();
    await settle();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(transport.delivered).toEqual(["kept"]);
  });

  it("survives a transport that throws synchronously and a reporter that throws", async () => {
    let calls = 0;
    const received: string[] = [];
    const send = (data: string): Promise<void> => {
      if (calls++ === 0) throw new Error("sync");
      received.push(data);
      return Promise.resolve();
    };
    const writer = createOrderedWriter(send, () => {
      throw new Error("reporter");
    });
    writer.write("x");
    await settle();
    writer.write("y");
    await settle();
    expect(received).toEqual(["y"]);
  });

  it("ignores empty writes", () => {
    const transport = manualTransport();
    const writer = createOrderedWriter(transport.send, vi.fn());
    writer.write("");
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("sends a very large write intact", async () => {
    const transport = manualTransport();
    const writer = createOrderedWriter(transport.send, vi.fn());
    const paste = "0123456789".repeat(100_000);
    writer.write(paste);
    transport.calls[0].resolve();
    await settle();
    expect(transport.delivered).toEqual([paste]);
  });

  it("drops unsent data and later writes once closed", async () => {
    const transport = manualTransport();
    const writer = createOrderedWriter(transport.send, vi.fn());
    writer.write("sent");
    writer.write("unsent");
    writer.close();
    writer.write("late");
    transport.calls[0].resolve();
    await settle();
    expect(transport.calls.map((call) => call.data)).toEqual(["sent"]);
  });
});
