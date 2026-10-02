import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  child: undefined as unknown as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  },
  transcript: undefined as unknown as Writable,
  stop: undefined as unknown as () => Promise<void>,
}));

vi.mock("node:child_process", () => ({ spawn: () => harness.child }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  mkdirSync: vi.fn(),
  createWriteStream: () => harness.transcript,
}));
vi.mock("../e2e-tauri/native-process-group", () => ({
  nativeProcessGroup: () => ({ pid: 100 }),
  reapNativeProcessGroupOnExit: vi.fn(),
  stopNativeProcessGroup: () => harness.stop(),
}));
vi.mock("../e2e-tauri/native-qualification", () => ({
  resolveNativeApplication: (application: string) => application,
  stopNativeQualificationProcesses: () => harness.stop(),
  createNativeProcessCleanupHooks: ({ stop }: { stop: () => Promise<void> }) => ({
    prepare: vi.fn(), begin: vi.fn(), cleanup: stop, complete: vi.fn(),
  }),
}));
vi.mock("../e2e-tauri/native-driver-ports", () => ({
  resolveNativeDriverPorts: () => ({ driver: 4520, backend: 4521 }),
  assertNativePortsAvailable: async () => {},
  waitForOwnedNativePorts: async () => {},
}));

const chunks: Buffer[] = [];
let finishTranscript: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  chunks.length = 0;
  finishTranscript = undefined;
  harness.child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null,
  });
  harness.transcript = new Writable({
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  });
  harness.stop = async () => {};
});
afterEach(() => {
  harness.child.stdout.unpipe();
  harness.child.stderr.unpipe();
  harness.child.stdout.destroy();
  harness.child.stderr.destroy();
  finishTranscript?.();
  harness.transcript.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function runningSession() {
  const { config } = await import("../e2e-tauri/wdio.conf");
  const beforeSession = config.beforeSession as (...args: unknown[]) => Promise<void>;
  await beforeSession({}, {});
  return config.afterSession as () => Promise<void>;
}

async function closeOutput() {
  const stdoutDrained = finished(harness.child.stdout);
  const stderrDrained = finished(harness.child.stderr);
  harness.child.stdout.end();
  harness.child.stderr.end();
  await Promise.all([stdoutDrained, stderrDrained]);
  harness.child.emit("close", 0, null);
}

describe.skipIf(process.platform === "win32")("WDIO driver transcript lifecycle", () => {
  it("retains stdout and stderr delivered after the driver exits", async () => {
    await runningSession();
    const completed = finished(harness.transcript);
    // Handle a pre-fix stream failure while still asserting it below.
    void completed.catch(() => {});
    harness.child.stdout.write("before exit\n");
    harness.child.exitCode = 0;
    harness.child.emit("exit", 0, null);
    harness.child.stdout.write("trailing stdout\n");
    harness.child.stderr.write("trailing stderr\n");
    await closeOutput();
    await completed;
    expect(Buffer.concat(chunks).toString()).toBe(
      "before exit\ntrailing stdout\ntrailing stderr\n",
    );
  });

  it("finalizes a transcript when spawn fails without an exit event", async () => {
    await runningSession();
    const completed = finished(harness.transcript);
    const failure = new Error("spawn ENOENT");
    // Port admission owns spawn-error reporting; emulate its listener here.
    harness.child.once("error", () => {});
    harness.child.emit("error", failure);
    harness.child.emit("close", -2, null);
    await completed;
    expect(harness.transcript.writableFinished).toBe(true);
  });

  it("keeps cleanup pending until the final transcript write completes", async () => {
    harness.transcript = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      final(callback) { finishTranscript = callback; },
    });
    const cleanup = await runningSession();
    let processesStopped = false;
    harness.stop = async () => {
      harness.child.exitCode = 0;
      harness.child.emit("exit", 0, null);
      await closeOutput();
      processesStopped = true;
    };
    let cleaned = false;
    const completed = cleanup().then(() => { cleaned = true; });
    await vi.waitFor(() => expect(processesStopped).toBe(true));
    expect(finishTranscript).toBeTypeOf("function");
    expect(cleaned).toBe(false);
    finishTranscript!();
    finishTranscript = undefined;
    await completed;
    expect(cleaned).toBe(true);
  });

  it("preserves a process cleanup failure when the transcript is unavailable", async () => {
    const cleanup = await runningSession();
    const failure = new Error("driver group remained alive");
    harness.stop = async () => { throw failure; };
    await expect(cleanup()).rejects.toBe(failure);
  });
  it("fails cleanup within its bound when exited-driver stdio never closes", async () => {
    const cleanup = await runningSession();
    harness.stop = async () => {
      harness.child.exitCode = 0;
      harness.child.emit("exit", 0, null);
    };
    vi.useFakeTimers();
    const completed = cleanup();
    const assertion = expect(completed).rejects.toThrow("transcript did not finish within 5000ms");
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(harness.transcript.destroyed).toBe(true);
    expect(harness.child.stdout.destroyed).toBe(true);
    expect(harness.child.stderr.destroyed).toBe(true);
    expect(harness.child.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails cleanup within its bound when the final write never completes", async () => {
    harness.transcript = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
      final(callback) { finishTranscript = callback; },
    });
    const cleanup = await runningSession();
    harness.child.exitCode = 0;
    harness.child.emit("exit", 0, null);
    await closeOutput();
    vi.useFakeTimers();
    const assertion = expect(cleanup()).rejects.toThrow("transcript did not finish within 5000ms");
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(harness.transcript.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a transcript write failure after successful process cleanup", async () => {
    const cleanup = await runningSession();
    const failure = new Error("transcript disk full");
    harness.child.exitCode = 0;
    harness.child.emit("exit", 0, null);
    harness.transcript.destroy(failure);
    await expect(cleanup()).rejects.toBe(failure);
  });

});
