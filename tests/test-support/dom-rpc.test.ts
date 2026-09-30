import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomRpc } from "../../src/test-support/dom-rpc";

let dataset: Record<string, string>;
const reply = () => JSON.parse(dataset.result ?? "null");
const send = (detail: unknown) => window.dispatchEvent(new CustomEvent("probe-op", { detail }));

beforeEach(() => {
  dataset = {};
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", { documentElement: { dataset } });
});
afterEach(() => vi.unstubAllGlobals());

function start(handlers: Record<string, (request: { token: string; op?: string; value?: number }) => unknown>, signal = new AbortController().signal) {
  createDomRpc({ event: "probe-op", resultKey: "result", readyKey: "ready", ownedKeys: ["extra"], signal, handlers });
  return signal;
}

describe("createDomRpc", () => {
  it("dispatches by op and publishes the result under the request token", async () => {
    start({ double: async ({ value }) => (value ?? 0) * 2, other: () => "wrong" });
    expect(dataset.ready).toBe("true");
    send({ token: "t1", op: "double", value: 21 });
    await vi.waitFor(() => expect(reply()).toEqual({ token: "t1", result: 42 }));
  });

  it("uses the default handler for requests without an op", async () => {
    start({ default: () => "accepted" });
    send({ token: "t2" });
    await vi.waitFor(() => expect(reply()).toEqual({ token: "t2", result: "accepted" }));
  });

  it("reports a rejected handler instead of leaving the request unanswered", async () => {
    start({ default: async () => { throw new Error("backend refused"); } });
    send({ token: "t3" });
    await vi.waitFor(() => expect(reply()).toEqual({ token: "t3", error: "Error: backend refused" }));
  });

  it("reports a synchronously throwing handler and an unknown op", async () => {
    start({ boom: () => { throw new Error("sync"); } });
    send({ token: "t4", op: "boom" });
    await vi.waitFor(() => expect(reply()).toEqual({ token: "t4", error: "Error: sync" }));
    send({ token: "t5", op: "missing" });
    await vi.waitFor(() => expect(reply()).toEqual({
      token: "t5", error: "Error: Unknown probe-op operation: missing",
    }));
  });

  it("does not resolve an op through the handler object's prototype", async () => {
    start({ default: () => "wrong" });
    send({ token: "proto", op: "toString" });
    await vi.waitFor(() => expect(reply()).toEqual({
      token: "proto", error: "Error: Unknown probe-op operation: toString",
    }));
  });

  it("settles a request whose result cannot be serialized", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    start({ default: () => cyclic });
    send({ token: "t6" });
    await vi.waitFor(() => expect(reply()).toMatchObject({ token: "t6", error: expect.stringContaining("circular") }));
  });

  it("ignores requests without a correlatable token", async () => {
    const handler = vi.fn();
    start({ default: handler });
    send(null);
    send({ op: "default" });
    send({ token: 7 });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(dataset.result).toBeUndefined();
  });

  it("stops listening, publishes nothing late and clears its markers once retired", async () => {
    const lifetime = new AbortController();
    let finish!: (value: string) => void;
    const handler = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    start({ default: handler }, lifetime.signal);
    dataset.extra = "owned";
    send({ token: "in-flight" });
    lifetime.abort();
    expect(dataset).toEqual({});
    finish("late");
    await Promise.resolve();
    await Promise.resolve();
    send({ token: "after" });
    expect(handler).toHaveBeenCalledOnce();
    expect(dataset).toEqual({});
  });

  it("installs nothing for an already-retired owner", () => {
    const lifetime = new AbortController();
    lifetime.abort();
    const handler = vi.fn();
    start({ default: handler }, lifetime.signal);
    send({ token: "t7" });
    expect(handler).not.toHaveBeenCalled();
    expect(dataset).toEqual({});
  });
});
