import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyRecoveryStorage } from "$lib/domain/file-recovery";
import type { FileRecoverySnapshot } from "$lib/domain/file-recovery";

const backend = vi.hoisted(() => ({ invoke: vi.fn(), channels: [] as Array<(value: FileRecoverySnapshot) => void> }));
vi.mock("$lib/api/common", () => ({ invoke: backend.invoke, isTauri: () => true }));
vi.mock("$lib/api/native-resource-session", () => ({ getNativeResourceSession: async () => "renderer-session" }));
vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    constructor(receive: (value: FileRecoverySnapshot) => void) { backend.channels.push(receive); }
  },
}));
import { fileRecoveryPort } from "$lib/api/file-recovery";

const snapshot = (revision: number): FileRecoverySnapshot => ({ revision: String(revision), items: [], storage: emptyRecoveryStorage(), error: null });
beforeEach(() => { backend.invoke.mockReset(); backend.channels.length = 0; });

describe("native recovery subscriptions", () => {
  it("binds inspection and lossless resolution to the acknowledged renderer session", async () => {
    backend.invoke.mockResolvedValue(snapshot(1));
    await fileRecoveryPort.list();
    expect(backend.invoke).toHaveBeenCalledWith("file_recovery_list", { sessionId: "renderer-session" });
    await fileRecoveryPort.inspect("operation-id");
    expect(backend.invoke).toHaveBeenCalledWith("file_recovery_inspect", { sessionId: "renderer-session", id: "operation-id" });
    await fileRecoveryPort.resolve("operation-id", "9007199254740993", "restore");
    expect(backend.invoke).toHaveBeenCalledWith("file_recovery_resolve", {
      sessionId: "renderer-session", id: "operation-id", generation: "9007199254740993", choice: "restore",
    });
    await fileRecoveryPort.retireEligible();
    expect(backend.invoke).toHaveBeenCalledWith("file_recovery_retire_eligible", { sessionId: "renderer-session" });
  });

  it("retires an uncertain failed registration and rejects its late channel delivery", async () => {
    backend.invoke.mockImplementation(async (command: string) => {
      if (command === "file_recovery_subscribe") throw new Error("acknowledgement lost");
    });
    const receive = vi.fn();
    await expect(fileRecoveryPort.subscribe(receive)).rejects.toThrow("acknowledgement lost");
    backend.channels[0](snapshot(5));
    expect(receive).not.toHaveBeenCalled();
    const registration = backend.invoke.mock.calls.find(([command]) => command === "file_recovery_subscribe")!;
    expect(backend.invoke).toHaveBeenCalledWith("file_recovery_unsubscribe", {
      sessionId: "renderer-session", subscriptionId: registration[1].subscriptionId,
    });
  });

  it("releasing an older subscription silences only its own channel", async () => {
    backend.invoke.mockImplementation(async (command: string) => command === "file_recovery_subscribe" ? snapshot(1) : undefined);
    const oldReceive = vi.fn();
    const newReceive = vi.fn();
    const oldRelease = await fileRecoveryPort.subscribe(oldReceive);
    const newRelease = await fileRecoveryPort.subscribe(newReceive);
    oldReceive.mockClear(); newReceive.mockClear();
    await oldRelease();
    backend.channels[0](snapshot(2)); backend.channels[1](snapshot(3));
    expect(oldReceive).not.toHaveBeenCalled();
    expect(newReceive).toHaveBeenCalledWith(snapshot(3));
    const registrations = backend.invoke.mock.calls.filter(([command]) => command === "file_recovery_subscribe");
    expect(registrations[0][1].subscriptionId).not.toBe(registrations[1][1].subscriptionId);
    expect(backend.invoke).toHaveBeenCalledWith("file_recovery_unsubscribe", {
      sessionId: "renderer-session", subscriptionId: registrations[0][1].subscriptionId,
    });
    await newRelease();
  });
});


it("fences copied old deliveries and acknowledgements as soon as a replacement starts", async () => {
  let acknowledge!: (value: FileRecoverySnapshot) => void;
  backend.invoke.mockImplementation((command: string) => command === "file_recovery_subscribe"
    ? new Promise<FileRecoverySnapshot>((resolve) => { acknowledge = resolve; }) : Promise.resolve());
  const oldReceive = vi.fn();
  const oldRegistration = fileRecoveryPort.subscribe(oldReceive);
  await Promise.resolve();
  const oldAck = acknowledge;
  const newReceive = vi.fn();
  const replacement = fileRecoveryPort.subscribe(newReceive);
  await Promise.resolve();
  backend.channels[0](snapshot(2));
  oldAck(snapshot(3));
  const releaseOld = await oldRegistration;
  expect(oldReceive).not.toHaveBeenCalled();
  acknowledge(snapshot(4));
  const releaseNew = await replacement;
  expect(newReceive).toHaveBeenCalledWith(snapshot(4));
  const tokens = backend.invoke.mock.calls.filter(([command]) => command === "file_recovery_subscribe").map(([, args]) => args.subscriptionId);
  expect(BigInt(tokens[1])).toBe(BigInt(tokens[0]) + 1n);
  await releaseOld();
  backend.channels[1](snapshot(5));
  expect(newReceive).toHaveBeenLastCalledWith(snapshot(5));
  await releaseNew();
});

it("preserves token ordering and delivery fencing across module re-evaluation", async () => {
  backend.invoke.mockResolvedValue(snapshot(1));
  const oldReceive = vi.fn();
  const releaseOld = await fileRecoveryPort.subscribe(oldReceive);
  oldReceive.mockClear();
  vi.resetModules();
  const reloaded = await import("$lib/api/file-recovery");
  const receive = vi.fn();
  const release = await reloaded.fileRecoveryPort.subscribe(receive);
  backend.channels[0](snapshot(9));
  expect(oldReceive).not.toHaveBeenCalled();
  const tokens = backend.invoke.mock.calls.filter(([command]) => command === "file_recovery_subscribe").map(([, args]) => args.subscriptionId);
  expect(BigInt(tokens[1])).toBe(BigInt(tokens[0]) + 1n);
  await releaseOld();
  await release();
});
