import { describe, expect, it, vi } from "vitest";
import type {
  FileRecoveryItem,
  FileRecoveryPort,
  FileRecoverySnapshot,
} from "$lib/domain/file-recovery";
import { createFileRecoveryState } from "$lib/state/file-recovery.svelte";
import { compareRecoveryCounters, emptyRecoveryStorage, isRecoveryCounter } from "$lib/domain/file-recovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function item(id = "recovery-a", generation: number | string = 1): FileRecoveryItem {
  return {
    id,
    generation: String(generation),
    originalPath: `/original/${id}.txt`,
    retainedPath: null,
    retainedBytes: null,
    status: "attention",
    message: "The original move needs review.",
    actions: ["restore", "discard"],
  };
}

function snapshot(revision: number | string, items = [item()]): FileRecoverySnapshot {
  return { revision: String(revision), items, storage: emptyRecoveryStorage(), error: null };
}

function port(overrides: Partial<FileRecoveryPort> = {}): FileRecoveryPort {
  return {
    subscribe: vi.fn(async (receive) => {
      receive(snapshot(1));
      return async () => {};
    }),
    list: vi.fn(async () => snapshot(1)),
    inspect: vi.fn(async (id) => snapshot(2, [{ ...item(id), retainedPath: `/retained/${id}.txt` }])),
    resolve: vi.fn(async () => snapshot(2, [])),
    retireEligible: vi.fn(async () => snapshot(2, [])),
    ...overrides,
  };
}

describe("file recovery state", () => {
  it("orders lossless counters and resolves the exact generation above JavaScript's integer range", async () => {
    let receive!: (value: FileRecoverySnapshot) => void;
    const resolve = vi.fn(async () => snapshot("9007199254740995", []));
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (next) => {
        receive = next;
        next(snapshot("9"));
        next(snapshot("10"));
        return async () => {};
      }),
      resolve,
    }));
    await state.start();
    expect(state.snapshot.revision).toBe("10");
    receive(snapshot("9007199254740993", [item("large", "9007199254740993")]));
    receive(snapshot("9007199254740992", [item("stale", "9007199254740992")]));
    expect(state.items[0].id).toBe("large");
    await state.resolve(state.items[0], "restore");
    expect(resolve).toHaveBeenCalledWith("large", "9007199254740993", "restore");
    await state.dispose();
  });

  it("accepts only canonical bounded decimal counters", () => {
    for (const value of [null, undefined, 1, "", "01", "-1", "+1", " 1", "1.0", "1e3", "9223372036854775808", "9".repeat(100_000)]) {
      expect(isRecoveryCounter(value)).toBe(false);
    }
    for (const value of ["0", "1", "9007199254740993", "9223372036854775807"]) {
      expect(isRecoveryCounter(value)).toBe(true);
    }
    expect(compareRecoveryCounters("9", "10")).toBeLessThan(0);
    expect(compareRecoveryCounters("9007199254740993", "9007199254740992")).toBeGreaterThan(0);
    expect(compareRecoveryCounters("42", "42")).toBe(0);
  });

  it("keeps the newest global revision when initial subscription delivery is reordered", async () => {
    let receive!: (value: FileRecoverySnapshot) => void;
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (next) => {
        receive = next;
        next(snapshot(4, [item("newest")]));
        next(snapshot(2, [item("older")]));
        return async () => {};
      }),
    }));

    await state.start();
    expect(state.snapshot.revision).toBe("4");
    expect(state.items.map(({ id }) => id)).toEqual(["newest"]);

    const later = snapshot(5, [item("later")]);
    receive(later);
    later.items[0].id = "mutated-by-port";
    expect(state.items.map(({ id }) => id)).toEqual(["later"]);
    await state.dispose();
  });

  it("restarts ownership and releases a subscription that completes after revocation", async () => {
    const first = deferred<() => Promise<void>>();
    const firstCalled = deferred<void>();
    const releaseFirst = vi.fn(async () => {});
    const releaseSecond = vi.fn(async () => {});
    const receives: Array<(value: FileRecoverySnapshot) => void> = [];
    let calls = 0;
    const state = createFileRecoveryState(port({
      subscribe: vi.fn((receive) => {
        receives.push(receive);
        calls += 1;
        if (calls === 1) {
          firstCalled.resolve();
          return first.promise;
        }
        receive(snapshot(3, [item("current")]));
        return Promise.resolve(releaseSecond);
      }),
    }));

    const oldStart = state.start();
    await firstCalled.promise;
    const newStart = state.start();
    receives[0](snapshot(9, [item("revoked")]));
    await newStart;
    expect(calls).toBe(2);
    expect(state.items.map(({ id }) => id)).toEqual(["current"]);
    first.resolve(releaseFirst);
    await oldStart;

    expect(releaseFirst).toHaveBeenCalledOnce();
    expect(state.items.map(({ id }) => id)).toEqual(["current"]);
    receives[0](snapshot(10, [item("still-revoked")]));
    expect(state.items.map(({ id }) => id)).toEqual(["current"]);
    await state.dispose();
    expect(releaseSecond).toHaveBeenCalledOnce();
  });

  it("attaches a replacement while an old unsubscribe is delayed or rejected", async () => {
    const firstRelease = deferred<void>();
    const releaseOld = vi.fn()
      .mockImplementationOnce(() => firstRelease.promise)
      .mockResolvedValueOnce(undefined);
    let subscriptions = 0;
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (receive) => {
        subscriptions += 1;
        receive(snapshot(subscriptions, [item(`owner-${subscriptions}`)]));
        return subscriptions === 1 ? releaseOld : async () => {};
      }),
    }));
    await state.start();

    await state.start();
    expect(state.items[0].id).toBe("owner-2");
    expect(releaseOld).toHaveBeenCalledOnce();
    firstRelease.reject(new Error("temporary unsubscribe failure"));
    await Promise.resolve();
    await Promise.resolve();

    await state.dispose();
    expect(releaseOld).toHaveBeenCalledTimes(2);
  });

  it("seals synchronously and drains a pending subscription during disposal", async () => {
    const registration = deferred<() => Promise<void>>();
    const registrationCalled = deferred<void>();
    const release = vi.fn(async () => {});
    let receive!: (value: FileRecoverySnapshot) => void;
    const state = createFileRecoveryState(port({
      subscribe: vi.fn((next) => {
        receive = next;
        registrationCalled.resolve();
        return registration.promise;
      }),
    }));

    const starting = state.start();
    await registrationCalled.promise;
    const disposing = state.dispose();
    receive(snapshot(8, [item("late")]));
    expect(state.items).toEqual([]);
    registration.resolve(release);
    await Promise.all([starting, disposing]);
    expect(release).toHaveBeenCalledOnce();
    expect(state.items).toEqual([]);
  });

  it("reports subscription, malformed, and list failures while accepting a later empty snapshot", async () => {
    const list = vi.fn<() => Promise<FileRecoverySnapshot>>()
      .mockResolvedValueOnce({ revision: Number.NaN, items: [], error: null } as unknown as FileRecoverySnapshot)
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce(snapshot(2, []));
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async () => { throw new Error("subscription unavailable"); }),
      list,
    }));

    await state.start();
    expect(state.error).toContain("subscription unavailable");
    await state.refresh();
    expect(state.error).toBe("Recovery status update was invalid");
    await state.refresh();
    expect(state.error).toContain("catalog unavailable");
    await state.refresh();
    expect(state.snapshot).toEqual(snapshot(2, []));
    await state.dispose();
  });

  it("accepts the highest global revision from reordered refresh replies", async () => {
    const olderRequest = deferred<FileRecoverySnapshot>();
    const newerRequest = deferred<FileRecoverySnapshot>();
    const list = vi.fn()
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(newerRequest.promise);
    const state = createFileRecoveryState(port({ list }));
    await state.start();

    const first = state.refresh();
    const second = state.refresh();
    newerRequest.resolve(snapshot(3, [item("revision-three")]));
    await second;
    olderRequest.resolve(snapshot(4, [item("revision-four")]));
    await first;

    expect(state.snapshot.revision).toBe("4");
    expect(state.items[0].id).toBe("revision-four");
    await state.dispose();
  });

  it("inspects only on demand and ignores an older inspection result", async () => {
    const first = deferred<FileRecoverySnapshot>();
    const inspect = vi.fn((id: string) => id === "a"
      ? first.promise
      : Promise.resolve(snapshot(2, [item("a"), { ...item(id), retainedPath: `/retained/${id}` }])));
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (receive) => {
        receive(snapshot(1, [item("a"), item("b")]));
        return async () => {};
      }),
      inspect,
    }));
    await state.start();
    expect(inspect).not.toHaveBeenCalled();

    const inspectingA = state.inspect("a");
    const inspectingB = state.inspect("b");
    await inspectingB;
    first.resolve(snapshot(3, [{ ...item("a"), retainedPath: "/retained/a" }, item("b")]));
    await inspectingA;

    expect(state.inspection?.id).toBe("b");
    expect(state.inspection?.retainedPath).toBe("/retained/b");
    await state.dispose();
  });

  it("clears inspection results and errors when the item's generation changes", async () => {
    let receive!: (value: FileRecoverySnapshot) => void;
    const inspect = vi.fn()
      .mockRejectedValueOnce(new Error("inspection failed"))
      .mockResolvedValueOnce(snapshot(3, [{ ...item("a", 2), retainedPath: "/retained/a" }]));
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (next) => {
        receive = next;
        next(snapshot(1, [item("a", 1)]));
        return async () => {};
      }),
      inspect,
    }));
    await state.start();

    await state.inspect("a");
    expect(state.inspectionError).toContain("inspection failed");
    receive(snapshot(2, [item("a", 2)]));
    expect(state.inspectionError).toBeNull();
    expect(state.inspectionId).toBeNull();

    await state.inspect("a");
    expect(state.inspection?.generation).toBe("2");
    receive(snapshot(4, [item("a", 3)]));
    expect(state.inspection).toBeNull();
    expect(state.inspectionId).toBeNull();
    await state.dispose();
  });

  it("publishes inspected actions and resolves the exact generation returned by inspection", async () => {
    const pending: FileRecoveryItem = {
      ...item("pending", 1),
      status: "pending",
      retainedPath: null,
      actions: [],
    };
    const inspected: FileRecoveryItem = {
      ...pending,
      generation: "2",
      status: "ready",
      retainedPath: "/retained/pending",
      actions: ["restore"],
    };
    const resolve = vi.fn(async () => snapshot(3, []));
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (receive) => {
        receive(snapshot(1, [pending]));
        return async () => {};
      }),
      inspect: vi.fn(async () => snapshot(2, [inspected])),
      resolve,
    }));
    await state.start();
    expect(state.items[0].actions).toEqual([]);

    await state.inspect("pending");
    expect(state.items[0]).toMatchObject({ generation: "2", actions: ["restore"] });
    expect(state.inspection).toMatchObject({ generation: "2", retainedPath: "/retained/pending" });
    await state.resolve(state.items[0], "restore");

    expect(resolve).toHaveBeenCalledWith("pending", "2", "restore");
    await state.dispose();
  });

  it("does not let a delayed inspected snapshot replace a newer channel revision", async () => {
    const inspected = deferred<FileRecoverySnapshot>();
    let receive!: (value: FileRecoverySnapshot) => void;
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (next) => {
        receive = next;
        next(snapshot(1, [{ ...item("a", 1), actions: [] }]));
        return async () => {};
      }),
      inspect: vi.fn(() => inspected.promise),
    }));
    await state.start();

    const inspecting = state.inspect("a");
    receive(snapshot(3, [{ ...item("a", 3), actions: ["discard"] }]));
    inspected.resolve(snapshot(2, [{ ...item("a", 2), actions: ["restore"] }]));
    await inspecting;

    expect(state.snapshot.revision).toBe("3");
    expect(state.items[0]).toMatchObject({ generation: "3", actions: ["discard"] });
    expect(state.inspection).toBeNull();
    await state.dispose();
  });

  it("does not publish a rejected old-generation inspection against a newer item", async () => {
    const inspected = deferred<FileRecoverySnapshot>();
    let receive!: (value: FileRecoverySnapshot) => void;
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (next) => {
        receive = next;
        next(snapshot(1, [item("a", 1)]));
        return async () => {};
      }),
      inspect: vi.fn(() => inspected.promise),
    }));
    await state.start();

    const inspecting = state.inspect("a");
    receive(snapshot(2, [item("a", 2)]));
    inspected.reject(new Error("generation one inspection failed"));
    await inspecting;

    expect(state.items[0].generation).toBe("2");
    expect(state.inspectionError).toBeNull();
    expect(state.inspectionId).toBeNull();
    expect(state.inspectionGeneration).toBeNull();
    await state.dispose();
  });

  it("uses native capability identity, waits for resolution, and drops a late result after disposal", async () => {
    const result = deferred<FileRecoverySnapshot>();
    const resolve = vi.fn(() => result.promise);
    const selected = item("selected", 7);
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (receive) => {
        receive(snapshot(1, [selected]));
        return async () => {};
      }),
      resolve,
    }));
    await state.start();

    const resolving = state.resolve(selected, "restore");
    expect(resolve).toHaveBeenCalledWith("selected", "7", "restore");
    expect(state.busyId).toBe("selected");
    expect(state.items).toHaveLength(1);
    const disposing = state.dispose();
    result.resolve(snapshot(9, []));
    await Promise.all([resolving, disposing]);
    expect(state.items).toEqual([]);
    expect(state.busyId).toBeNull();
  });

  it("does not publish a late resolution from the subscription owner replaced by restart", async () => {
    const result = deferred<FileRecoverySnapshot>();
    const selected = item("selected", 7);
    let subscriptions = 0;
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (receive) => {
        subscriptions += 1;
        receive(subscriptions === 1
          ? snapshot(1, [selected])
          : snapshot(2, [item("replacement")]));
        return async () => {};
      }),
      resolve: vi.fn(() => result.promise),
    }));
    await state.start();

    const resolving = state.resolve(selected, "restore");
    await state.start();
    result.resolve(snapshot(20, []));
    await resolving;

    expect(state.snapshot.revision).toBe("2");
    expect(state.items[0].id).toBe("replacement");
    await state.dispose();
  });

  it("refuses a resolution choice absent from the native-authorized actions", async () => {
    const resolve = vi.fn(async () => snapshot(2, []));
    const restoreOnly: FileRecoveryItem = { ...item(), actions: ["restore"] };
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (receive) => {
        receive(snapshot(1, [restoreOnly]));
        return async () => {};
      }),
      resolve,
    }));
    await state.start();

    await state.resolve(restoreOnly, "discard");
    expect(resolve).not.toHaveBeenCalled();
    expect(state.error).toContain("no longer authorized");
    await state.dispose();
  });

  it("rechecks current generation and actions before resolving a displayed capability", async () => {
    let receive!: (value: FileRecoverySnapshot) => void;
    const resolve = vi.fn(async () => snapshot(4, []));
    const displayed = item("changing", 1);
    const state = createFileRecoveryState(port({
      subscribe: vi.fn(async (next) => {
        receive = next;
        next(snapshot(1, [displayed]));
        return async () => {};
      }),
      resolve,
    }));
    await state.start();

    receive(snapshot(2, [{ ...displayed, actions: ["restore"] }]));
    await state.resolve(displayed, "discard");
    receive(snapshot(3, [item("changing", 2)]));
    await state.resolve(displayed, "restore");

    expect(resolve).not.toHaveBeenCalled();
    expect(state.error).toContain("no longer authorized");
    await state.dispose();
  });
});


it("keeps inspected presentation through same-generation inventory but invalidates changed authority", async () => {
  let receive!: (value: FileRecoverySnapshot) => void;
  const state = createFileRecoveryState(port({ subscribe: async (next) => {
    receive = next;
    next(snapshot(1));
    return async () => {};
  }}));
  await state.start();
  await state.inspect("recovery-a");
  const inspected = { ...state.items[0], actions: [...state.items[0].actions] };
  const pending = { ...inspected, status: "pending" as const, message: "Inspect to review", actions: [] };
  receive(snapshot(3, [pending]));
  expect(state.items[0]).toEqual(inspected);
  expect(state.inspection?.retainedPath).toBe(inspected.retainedPath);
  receive(snapshot(4, [{ ...pending, generation: "2" }]));
  expect(state.items[0].actions).toEqual([]);
  expect(state.items[0].status).toBe("pending");
  expect(state.inspection).toBeNull();
  await state.dispose();
});

it("exposes native retention accounting and rejects a snapshot with malformed storage", async () => {
  let receive!: (value: FileRecoverySnapshot) => void;
  const state = createFileRecoveryState(port({ subscribe: async (next) => {
    receive = next;
    next({ ...snapshot(1, []), storage: { ...emptyRecoveryStorage(), usedBytes: "10", budgetBytes: "1024", records: 1, recordBudget: 8, discardable: 1 } });
    return async () => {};
  }}));
  await state.start();
  expect(state.storage.usedBytes).toBe("10");
  expect(state.storage.recordBudget).toBe(8);
  expect(state.error).toBeNull();

  // A storage block that is not lossless accounting must not be adopted.
  receive({ ...snapshot(2, []), storage: { ...emptyRecoveryStorage(), usedBytes: 10 } as never });
  expect(state.storage.usedBytes).toBe("10");
  expect(state.storage.records).toBe(1);
  expect(state.error).toBe("Recovery status update was invalid");
  await state.dispose();
});

it("applies a retention enforcement pass and reports its failure without losing the inventory", async () => {
  const retireEligible = vi.fn(async () => ({ ...snapshot(5, []), storage: { ...emptyRecoveryStorage(), records: 0, recordBudget: 8 } }));
  const state = createFileRecoveryState(port({ retireEligible }));
  await state.start();
  expect(state.items).toHaveLength(1);
  await state.retireEligible();
  expect(retireEligible).toHaveBeenCalledOnce();
  expect(state.items).toEqual([]);
  expect(state.storage.recordBudget).toBe(8);
  expect(state.loading).toBe(false);

  const failing = createFileRecoveryState(port({
    retireEligible: vi.fn(async () => { throw new Error("the location is unavailable"); }),
  }));
  await failing.start();
  await failing.retireEligible();
  expect(failing.error).toBe("the location is unavailable");
  expect(failing.items).toHaveLength(1);
  expect(failing.loading).toBe(false);
  await Promise.all([state.dispose(), failing.dispose()]);
});
