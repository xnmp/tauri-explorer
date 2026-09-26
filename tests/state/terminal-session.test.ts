import { describe, expect, it, vi } from "vitest";
import { createTerminalSession, type TerminalSessionDependencies } from "$lib/state/terminal-session";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness(overrides: Partial<TerminalSessionDependencies> = {}) {
  const unlisten = vi.fn();
  const dependencies: TerminalSessionDependencies = {
    reserveId: vi.fn().mockResolvedValue(41),
    listenOutput: vi.fn().mockResolvedValue(unlisten),
    listenExit: vi.fn().mockResolvedValue(unlisten),
    listenCwd: vi.fn().mockResolvedValue(unlisten),
    spawn: vi.fn().mockResolvedValue({ shellKind: "posix", wslDistro: null }),
    kill: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const callbacks = { output: vi.fn(), cwd: vi.fn(), exit: vi.fn(), writeError: vi.fn() };
  return { dependencies, callbacks, session: createTerminalSession(dependencies, callbacks), unlisten };
}

describe("terminal session lifetime", () => {
  it("kills an id acquired after disposal and never starts its PTY", async () => {
    const reservation = deferred<number>();
    const h = harness({ reserveId: vi.fn().mockReturnValue(reservation.promise) });
    const starting = h.session.start("/work", 80, 24);
    const disposal = h.session.dispose();
    reservation.resolve(41);
    await Promise.all([starting, disposal]);
    expect(h.dependencies.kill).toHaveBeenCalledWith(41);
    expect(h.dependencies.spawn).not.toHaveBeenCalled();
    expect(h.session.id).toBeNull();
  });

  it("detaches a listener that resolves after disposal", async () => {
    const listening = deferred<() => void>();
    const lateUnlisten = vi.fn();
    const h = harness({ listenOutput: vi.fn().mockReturnValue(listening.promise) });
    const starting = h.session.start("/work", 80, 24);
    await Promise.resolve();
    await Promise.resolve();
    const disposal = h.session.dispose();
    listening.resolve(lateUnlisten);
    await Promise.all([starting, disposal]);
    expect(lateUnlisten).toHaveBeenCalledOnce();
    expect(h.dependencies.kill).toHaveBeenCalledWith(41);
    expect(h.dependencies.spawn).not.toHaveBeenCalled();
  });

  it("kills a PTY whose spawn resolves after disposal", async () => {
    const spawning = deferred<{ shellKind: "posix"; wslDistro: null }>();
    const h = harness({ spawn: vi.fn().mockReturnValue(spawning.promise) });
    const starting = h.session.start("/work", 80, 24);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const disposal = h.session.dispose();
    spawning.resolve({ shellKind: "posix", wslDistro: null });
    await Promise.all([starting, disposal]);
    expect(h.dependencies.kill).toHaveBeenCalledWith(41);
    expect(h.unlisten).toHaveBeenCalledTimes(3);
    expect(h.session.id).toBeNull();
  });

  it("cleans up the reservation and listeners when spawn fails", async () => {
    const h = harness({ spawn: vi.fn().mockRejectedValue(new Error("spawn failed")) });
    await expect(h.session.start("/work", 80, 24)).rejects.toThrow("spawn failed");
    expect(h.dependencies.kill).toHaveBeenCalledWith(41);
    expect(h.unlisten).toHaveBeenCalledTimes(3);
    expect(h.session.id).toBeNull();
  });

  it("still kills the reservation when an event unlistener throws", async () => {
    const brokenUnlisten = vi.fn(() => { throw new Error("unlisten failed"); });
    const healthyUnlisten = vi.fn();
    const h = harness({
      listenOutput: vi.fn().mockResolvedValue(healthyUnlisten),
      listenExit: vi.fn().mockResolvedValue(brokenUnlisten),
      listenCwd: vi.fn().mockResolvedValue(healthyUnlisten),
      spawn: vi.fn().mockRejectedValue(new Error("spawn failed")),
    });
    await expect(h.session.start("/work", 80, 24)).rejects.toThrow("spawn failed");
    expect(brokenUnlisten).toHaveBeenCalledOnce();
    expect(healthyUnlisten).toHaveBeenCalledTimes(2);
    expect(h.dependencies.kill).toHaveBeenCalledWith(41);
  });

  it("does not let a stopped generation remove its replacement", async () => {
    const h = harness();
    await h.session.start("/first", 80, 24);
    await h.session.stop();
    await h.session.start("/second", 100, 30);
    expect(h.session.id).toBe(41);
    expect(h.dependencies.spawn).toHaveBeenCalledTimes(2);
    expect(h.dependencies.kill).toHaveBeenCalledTimes(1);
    await h.session.dispose();
  });
});

describe("terminal session input", () => {
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it("refuses input until the PTY is running, then delivers it to that PTY", async () => {
    const h = harness();
    expect(h.session.write("early")).toBe(false);
    await h.session.start("/work", 80, 24);
    expect(h.session.write("ls\r")).toBe(true);
    expect(h.dependencies.write).toHaveBeenCalledWith(41, "ls\r");
    expect(h.dependencies.write).not.toHaveBeenCalledWith(41, "early");
  });

  it("keeps keystrokes in order while an earlier write is still in flight (#709)", async () => {
    const sends: { data: string; resolve(): void }[] = [];
    const write = vi.fn((_id: number, data: string) =>
      new Promise<void>((resolve) => sends.push({ data, resolve })));
    const h = harness({ write });
    await h.session.start("/work", 80, 24);
    for (const character of "print") h.session.write(character);
    expect(sends.map((send) => send.data)).toEqual(["p"]);
    sends[0].resolve();
    await settle();
    expect(sends.map((send) => send.data)).toEqual(["p", "rint"]);
  });

  it("drops unsent input from a stopped PTY instead of sending it to its successor", async () => {
    const sends: { id: number; data: string; resolve(): void }[] = [];
    const write = vi.fn((id: number, data: string) =>
      new Promise<void>((resolve) => sends.push({ id, data, resolve })));
    let nextId = 41;
    const h = harness({ write, reserveId: vi.fn(async () => nextId++) });
    await h.session.start("/work", 80, 24);
    h.session.write("a");
    h.session.write("stale");
    await h.session.stop();
    expect(h.session.write("dead")).toBe(false);
    await h.session.start("/work", 80, 24);
    h.session.write("fresh");
    sends[0].resolve();
    await settle();
    expect(sends.map(({ id, data }) => [id, data])).toEqual([[41, "a"], [42, "fresh"]]);
  });

  it("reports a failed write and keeps accepting input", async () => {
    const failure = new Error("pty write failed");
    const write = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const h = harness({ write });
    await h.session.start("/work", 80, 24);
    h.session.write("x");
    await settle();
    h.session.write("y");
    await settle();
    expect(h.callbacks.writeError).toHaveBeenCalledWith(failure);
    expect(write).toHaveBeenLastCalledWith(41, "y");
  });

  it("closes input when the shell exits", async () => {
    let exitHandler: (() => void) | undefined;
    const h = harness({
      listenExit: vi.fn(async (_id: number, handler: () => void) => {
        exitHandler = handler;
        return vi.fn();
      }),
    });
    await h.session.start("/work", 80, 24);
    exitHandler?.();
    expect(h.session.write("after-exit")).toBe(false);
    expect(h.dependencies.write).not.toHaveBeenCalled();
  });
});
