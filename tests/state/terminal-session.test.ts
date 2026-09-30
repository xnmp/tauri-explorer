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
    write: vi.fn().mockResolvedValue({ droppedBytes: 0 }),
    ...overrides,
  };
  const callbacks = { output: vi.fn(), cwd: vi.fn(), exit: vi.fn(), writeError: vi.fn(), inputDropped: vi.fn() };
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
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  /** A backend whose writes stay in flight until the test settles them. */
  function manualWrites() {
    const sends: { id: number; seq: number; data: string; resolve(): void; reject(error: unknown): void }[] = [];
    const write = vi.fn((id: number, seq: number, data: string) =>
      new Promise<{ droppedBytes: number }>((resolve, reject) => {
        sends.push({ id, seq, data, resolve: () => resolve({ droppedBytes: 0 }), reject });
      }));
    const drain = async () => {
      for (let index = 0; index < sends.length; index++) {
        sends[index].resolve();
        await settle();
      }
    };
    const log = () => sends.map(({ id, seq, data }) => [id, seq, data]);
    return { sends, write, drain, log };
  }

  it("queues keystrokes typed while the shell starts and sends them to its terminal first (#882)", async () => {
    const spawning = deferred<{ shellKind: "posix"; wslDistro: null }>();
    const h = harness({ spawn: vi.fn().mockReturnValue(spawning.promise) });
    const starting = h.session.start("/work", 80, 24);
    h.session.write("ec");
    h.session.write("ho ");
    await settle();
    h.session.write("hi");
    spawning.resolve({ shellKind: "posix", wslDistro: null });
    await starting;
    h.session.write("\r");
    await settle();
    const sent = vi.mocked(h.dependencies.write).mock.calls;
    expect(sent.map(([id]) => id)).toEqual(sent.map(() => 41));
    expect(sent.map(([, seq]) => seq)).toEqual(sent.map((_, index) => index));
    expect(sent.map(([, , data]) => data).join("")).toBe("echo hi\r");
  });

  it("drops input while no shell is running or starting", async () => {
    let exitHandler: (() => void) | undefined;
    const h = harness({
      listenExit: vi.fn(async (_id: number, handler: () => void) => {
        exitHandler = handler;
        return vi.fn();
      }),
    });
    h.session.write("before start");
    await h.session.start("/work", 80, 24);
    exitHandler?.();
    h.session.write("after exit");
    await settle();
    expect(h.dependencies.write).not.toHaveBeenCalled();
  });

  it("keeps keystrokes in order while an earlier write is still in flight (#709)", async () => {
    const pty = manualWrites();
    const h = harness({ write: pty.write });
    await h.session.start("/work", 80, 24);
    for (const character of "print") h.session.write(character);
    expect(pty.log()).toEqual([[41, 0, "p"]]);
    await pty.drain();
    expect(pty.log()).toEqual([[41, 0, "p"], [41, 1, "rint"]]);
  });

  it("keeps Enter behind a paste whose clipboard read is still pending", async () => {
    const pty = manualWrites();
    const h = harness({ write: pty.write });
    await h.session.start("/work", 80, 24);
    const clipboard = deferred<string>();
    h.session.write(clipboard.promise);
    h.session.write("\r");
    await pty.drain();
    expect(pty.log()).toEqual([]);
    clipboard.resolve("echo pasted");
    await settle();
    await pty.drain();
    expect(pty.log().map(([, , data]) => data).join("")).toBe("echo pasted\r");
  });

  it("drops unsent input from a stopped PTY instead of sending it to its successor", async () => {
    const pty = manualWrites();
    let nextId = 41;
    const h = harness({ write: pty.write, reserveId: vi.fn(async () => nextId++) });
    await h.session.start("/work", 80, 24);
    h.session.write("a");
    h.session.write("stale");
    await h.session.stop();
    h.session.write("dead");
    await h.session.start("/work", 80, 24);
    h.session.write("fresh");
    await pty.drain();
    expect(pty.log()).toEqual([[41, 0, "a"], [42, 0, "fresh"]]);
  });

  it("delivers keys typed during a restart to the replacement shell, never the old one", async () => {
    const pty = manualWrites();
    const killing = deferred<void>();
    let nextId = 41;
    const h = harness({
      write: pty.write,
      reserveId: vi.fn(async () => nextId++),
      kill: vi.fn().mockReturnValue(killing.promise),
    });
    await h.session.start("/work", 80, 24);
    h.session.write("old");
    const pendingPaste = deferred<string>();
    h.session.write(pendingPaste.promise);
    const restarting = h.session.restart("/work", 80, 24);
    h.session.write("typed ");
    await settle();
    h.session.write("while killing");
    pendingPaste.resolve("for the old shell");
    killing.resolve();
    await expect(restarting).resolves.toEqual({ shellKind: "posix", wslDistro: null });
    h.session.write("\r");
    await pty.drain();
    expect(pty.log().filter(([id]) => id === 41)).toEqual([[41, 0, "old"]]);
    expect(pty.log().filter(([id]) => id === 42).map(([, , data]) => data).join(""))
      .toBe("typed while killing\r");
    expect(h.session.id).toBe(42);
  });

  it("resolves a queued insertion against the shell that actually spawned (#409)", async () => {
    const spawning = deferred<{ shellKind: "powershell"; wslDistro: null }>();
    const h = harness({ spawn: vi.fn().mockReturnValue(spawning.promise) });
    const starting = h.session.start("/work", 80, 24);
    h.session.insert((info) => `[${info.shellKind}]`);
    h.session.write(" typed");
    spawning.resolve({ shellKind: "powershell", wslDistro: null });
    await starting;
    await settle();
    const sent = vi.mocked(h.dependencies.write).mock.calls.map(([, , data]) => data).join("");
    expect(sent).toBe("[powershell] typed");
  });

  it("closes input when the shell fails to start, and sends nothing for a pending insertion", async () => {
    const build = vi.fn(() => "inserted");
    const h = harness({ spawn: vi.fn().mockRejectedValue(new Error("spawn failed")) });
    const starting = h.session.start("/work", 80, 24);
    h.session.insert(build);
    await expect(starting).rejects.toThrow("spawn failed");
    await settle();
    vi.mocked(h.dependencies.write).mockClear();
    h.session.write("after failure");
    await settle();
    expect(h.dependencies.write).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("holds an insertion requested while the shell is exited for the restarted shell", async () => {
    let exitHandler: (() => void) | undefined;
    let nextId = 41;
    const h = harness({
      reserveId: vi.fn(async () => nextId++),
      listenExit: vi.fn(async (_id: number, handler: () => void) => {
        exitHandler = handler;
        return vi.fn();
      }),
    });
    await h.session.start("/work", 80, 24);
    exitHandler?.();
    h.session.insert((info) => `'/tmp/a b' (${info.shellKind})`);
    h.session.write("dropped while exited");
    await settle();
    expect(h.dependencies.write).not.toHaveBeenCalled();
    await h.session.restart("/work", 80, 24);
    h.session.write(" typed");
    await settle();
    const sent = vi.mocked(h.dependencies.write).mock.calls;
    expect(sent.every(([id]) => id === 42)).toBe(true);
    expect(sent.map(([, , data]) => data).join("")).toBe("'/tmp/a b' (posix) typed");
  });

  it("lets a stop requested during a restart cancel the replacement", async () => {
    const killing = deferred<void>();
    const h = harness({ kill: vi.fn().mockReturnValue(killing.promise) });
    await h.session.start("/work", 80, 24);
    const restarting = h.session.restart("/work", 80, 24);
    const stopping = h.session.stop();
    h.session.write("after stop");
    killing.resolve();
    await expect(restarting).resolves.toBeNull();
    await stopping;
    expect(h.dependencies.spawn).toHaveBeenCalledTimes(1);
    expect(h.session.id).toBeNull();
    expect(h.dependencies.write).not.toHaveBeenCalled();
  });

  it("starts a shell requested while a stop is still killing the old one", async () => {
    const killing = deferred<void>();
    let nextId = 41;
    const h = harness({ reserveId: vi.fn(async () => nextId++), kill: vi.fn().mockReturnValue(killing.promise) });
    await h.session.start("/work", 80, 24);
    const stopping = h.session.stop();
    const starting = h.session.start("/work", 80, 24);
    h.session.write("typeahead");
    killing.resolve();
    await stopping;
    await expect(starting).resolves.toEqual({ shellKind: "posix", wslDistro: null });
    await settle();
    expect(h.session.id).toBe(42);
    expect(vi.mocked(h.dependencies.write).mock.calls).toEqual([[42, 0, "typeahead"]]);
  });

  it("reports a failed write, reuses its sequence number and keeps accepting input", async () => {
    const failure = new Error("ipc failed");
    const write = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ droppedBytes: 0 });
    const h = harness({ write });
    await h.session.start("/work", 80, 24);
    h.session.write("x");
    await settle();
    h.session.write("y");
    await settle();
    expect(h.callbacks.writeError).toHaveBeenCalledWith(failure);
    expect(write.mock.calls).toEqual([[41, 0, "x"], [41, 0, "y"]]);
  });

  it("reports typeahead the backend had to discard", async () => {
    const write = vi.fn().mockResolvedValue({ droppedBytes: 7 });
    const h = harness({ write });
    await h.session.start("/work", 80, 24);
    h.session.write("discard");
    await settle();
    expect(h.callbacks.inputDropped).toHaveBeenCalledWith(7);
  });

  it("sends nothing queued during a start that is disposed before it gets an id", async () => {
    const reservation = deferred<number>();
    const h = harness({ reserveId: vi.fn().mockReturnValue(reservation.promise) });
    const starting = h.session.start("/work", 80, 24);
    h.session.write("typed");
    const disposal = h.session.dispose();
    reservation.resolve(41);
    await Promise.all([starting, disposal]);
    h.session.write("after dispose");
    await settle();
    expect(h.dependencies.write).not.toHaveBeenCalled();
  });
});
