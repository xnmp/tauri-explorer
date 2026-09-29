import { describe, expect, it, vi } from "vitest";
import { createTerminalInputOrder } from "$lib/state/terminal-input-order";

const settle = async () => { for (let index = 0; index < 4; index++) await Promise.resolve(); };

describe("terminal input order", () => {
  it("keeps Enter after a delayed paste and preserves xterm's emitted bytes", async () => {
    const sent: string[] = [];
    const input = createTerminalInputOrder((data) => sent.push(data));
    let resolveRead!: (text: string) => void;
    const read = new Promise<string>((resolve) => { resolveRead = resolve; });
    input.paste(read, (text) => input.write(`\x1b[200~${text}\x1b[201~`), vi.fn());
    input.write("\r");
    expect(sent).toEqual([]);
    resolveRead("echo proof");
    await settle();
    expect(sent).toEqual(["\x1b[200~echo proof\x1b[201~", "\r"]);
  });

  it("keeps two delayed paste reads in key order even when they resolve backward", async () => {
    const sent: string[] = [];
    const input = createTerminalInputOrder((data) => sent.push(data));
    let first!: (text: string) => void;
    let second!: (text: string) => void;
    input.paste(new Promise((resolve) => { first = resolve; }), input.write, vi.fn());
    input.paste(new Promise((resolve) => { second = resolve; }), input.write, vi.fn());
    input.write("!");
    second("second");
    await settle();
    expect(sent).toEqual([]);
    first("first");
    await settle();
    expect(sent).toEqual(["first", "second", "!"]);
  });

  it("releases later input after a failed read and drops a stale read after close", async () => {
    const sent: string[] = [];
    const onError = vi.fn();
    const input = createTerminalInputOrder((data) => sent.push(data));
    input.paste(Promise.reject(new Error("denied")), input.write, onError);
    input.write("a");
    await settle();
    expect(sent).toEqual(["a"]);
    expect(onError).toHaveBeenCalledOnce();
    let resolveRead!: (text: string) => void;
    input.paste(new Promise((resolve) => { resolveRead = resolve; }), input.write, onError);
    input.close();
    resolveRead("stale");
    await settle();
    expect(sent).toEqual(["a"]);
  });
});
