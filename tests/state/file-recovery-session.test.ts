import { expect, it, vi } from "vitest";
import { createFileRecoverySession } from "$lib/state/file-recovery-session.svelte";
import { createFileRecoveryState } from "$lib/state/file-recovery.svelte";
import { emptyRecoveryStorage } from "$lib/domain/file-recovery";
import type { FileRecoveryPort } from "$lib/domain/file-recovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const release = vi.fn(async () => {});
  const port: FileRecoveryPort = {
    subscribe: vi.fn(async (receive) => { receive({ revision: "1", items: [], storage: emptyRecoveryStorage(), error: null }); return release; }),
    list: vi.fn(), inspect: vi.fn(), resolve: vi.fn(), retireEligible: vi.fn(),
  };
  const state = createFileRecoveryState(port);
  const load = vi.fn(async () => state);
  return { state, port, load, release };
}

it("has no module or subscription work until demanded and shares concurrent demand", async () => {
  const f = fixture();
  const session = createFileRecoverySession(f.load);
  expect(f.load).not.toHaveBeenCalled();
  expect(f.port.subscribe).not.toHaveBeenCalled();
  await Promise.all([session.start(), session.start(), session.refresh()]);
  expect(f.load).toHaveBeenCalledOnce();
  expect(f.port.subscribe).toHaveBeenCalledOnce();
  expect(session.error).toBeNull();
  expect(session.loading).toBe(false);
  await session.start();
  expect(f.port.subscribe).toHaveBeenCalledOnce();
  await session.dispose();
  expect(f.release).toHaveBeenCalledOnce();
});

it("does not attach after disposal during a delayed module import", async () => {
  const f = fixture();
  const imported = deferred<typeof f.state>();
  const session = createFileRecoverySession(() => imported.promise);
  const start = session.start();
  await Promise.resolve();
  await session.dispose();
  imported.resolve(f.state);
  await start;
  expect(f.port.subscribe).not.toHaveBeenCalled();
  expect(session.state).toBeNull();
  await session.start();
  expect(f.port.subscribe).not.toHaveBeenCalled();
});

it("retires a registration which acknowledges only after the page closes", async () => {
  const f = fixture();
  const registration = deferred<() => Promise<void>>();
  vi.mocked(f.port.subscribe).mockReturnValue(registration.promise);
  const session = createFileRecoverySession(f.load);
  const start = session.start();
  await vi.waitFor(() => expect(f.port.subscribe).toHaveBeenCalledOnce());
  const stopping = session.dispose();
  let retired = false;
  const repeated = session.dispose().then(() => { retired = true; });
  await Promise.resolve();
  expect(retired).toBe(false);
  registration.resolve(f.release);
  await Promise.all([start, stopping, repeated]);
  expect(f.release).toHaveBeenCalledOnce();
  expect(session.state).toBeNull();
});

it("recovers from module failure and reconnects a failed subscription on explicit refresh", async () => {
  const f = fixture();
  f.load.mockRejectedValueOnce(new Error("module unavailable"));
  const session = createFileRecoverySession(f.load);
  await session.start();
  expect(session.error).toBe("module unavailable");
  vi.mocked(f.port.subscribe).mockRejectedValueOnce(new Error("recovery storage unavailable"));
  await session.refresh();
  expect(session.error).toBe("recovery storage unavailable");
  await session.refresh();
  expect(session.error).toBeNull();
  expect(f.port.subscribe).toHaveBeenCalledTimes(2);
  expect(f.load).toHaveBeenCalledTimes(2);
  await session.dispose();
});

it("one retired page cannot clear a replacement page's independent recovery state", async () => {
  const old = fixture();
  const next = fixture();
  const first = createFileRecoverySession(old.load);
  const second = createFileRecoverySession(next.load);
  await first.start();
  const stopping = first.dispose();
  await second.start();
  await stopping;
  expect(second.state?.snapshot.revision).toBe("1");
  expect(next.release).not.toHaveBeenCalled();
  await second.dispose();
});
