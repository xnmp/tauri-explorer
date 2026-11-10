import { describe, expect, it, vi } from "vitest";
import { emptyRecoveryStorage } from "$lib/domain/file-recovery";
import type { FileRecoveryItem, FileRecoveryPort, FileRecoverySnapshot } from "$lib/domain/file-recovery";
import { createFileRecoveryState } from "$lib/state/file-recovery.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const item = (id: string, extra: Partial<FileRecoveryItem> = {}): FileRecoveryItem => ({
  id, generation: "1", originalPath: `/o/${id}`, retainedPath: null, retainedBytes: null,
  status: "attention", message: "", actions: ["restore"], ...extra,
});
const snap = (revision: string, items: FileRecoveryItem[]): FileRecoverySnapshot =>
  ({ revision, items, storage: emptyRecoveryStorage(), error: null });

async function started(inspect: FileRecoveryPort["inspect"], revision = "1") {
  const port: FileRecoveryPort = {
    subscribe: vi.fn(async (receive) => { receive(snap(revision, [item("a"), item("b")])); return async () => {}; }),
    list: vi.fn(), inspect, resolve: vi.fn(), retireEligible: vi.fn(),
  };
  const state = createFileRecoveryState(port);
  await state.start();
  return state;
}

describe("file recovery store inspection wiring", () => {
  it("keeps the previous inspection exposed while a new probe is in flight", async () => {
    const second = deferred<FileRecoverySnapshot>();
    const inspect = vi.fn()
      .mockResolvedValueOnce(snap("2", [item("a", { retainedPath: "/r/a" }), item("b")]))
      .mockReturnValueOnce(second.promise);
    const state = await started(inspect);
    await state.inspect("a");
    expect(state.inspection?.id).toBe("a");

    const pending = state.inspect("b");
    expect(state.inspectingId).toBe("b");
    expect(state.inspection?.id).toBe("a");

    second.resolve(snap("3", [item("a"), item("b", { retainedPath: "/r/b" })]));
    await pending;
    expect(state.inspection?.id).toBe("b");
    expect(state.inspectingId).toBeNull();
  });

  it("does not apply the snapshot of a superseded probe that resolves late", async () => {
    const a = deferred<FileRecoverySnapshot>();
    const b = deferred<FileRecoverySnapshot>();
    const inspect = vi.fn((id: string) => (id === "a" ? a.promise : b.promise));
    const state = await started(inspect);
    const inspectingA = state.inspect("a");
    const inspectingB = state.inspect("b");

    a.resolve(snap("9", [item("a", { retainedPath: "/late/a" }), item("b")]));
    await inspectingA;
    expect(state.snapshot.revision).toBe("1");
    expect(state.items.find(({ id }) => id === "a")?.retainedPath).toBeNull();
    expect(state.inspectingId).toBe("b");
    expect(state.inspection).toBeNull();

    b.resolve(snap("2", [item("a"), item("b", { retainedPath: "/r/b" })]));
    await inspectingB;
    expect(state.inspection?.id).toBe("b");
    expect(state.snapshot.revision).toBe("2");
  });

  it.each([
    ["an older revision", snap("3", [item("a"), item("b")])],
    ["an invalid snapshot", { revision: "nope" } as unknown as FileRecoverySnapshot],
  ])("stops inspecting and exposes nothing when the probe returns %s", async (_name, result) => {
    const state = await started(vi.fn(async () => result), "5");
    await state.inspect("a");
    expect(state.inspectingId).toBeNull();
    expect(state.inspectionId).toBeNull();
    expect(state.inspection).toBeNull();
  });
});
