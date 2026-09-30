import { expect, it, vi } from "vitest";
import type { FileEntry } from "$lib/domain/file";

const listeners = new Set<(event: { payload: { revision: number } }) => void>();
const native = vi.hoisted(() => ({
  revision: 0,
  entries: null as FileEntry[] | null,
  operation: null as "copy" | "cut" | null,
  paths: [] as string[],
  tail: Promise.resolve() as Promise<unknown>,
  writes: [] as Array<{ paths: string[]; finish: () => void }>,
  lease: null as number | null,
}));

vi.mock("$lib/api/os-clipboard", () => ({
  osClipboardPublish: (entries: FileEntry[], operation: "copy" | "cut") => {
    const job = native.tail.then(() => new Promise<void>((resolve) => {
      native.writes.push({ paths: entries.map((entry) => entry.path), finish: resolve });
    })).then(() => {
      native.revision++;
      native.entries = entries;
      native.operation = operation;
      native.paths = entries.map((entry) => entry.path);
      return { revision: native.revision, entries, operation, paths: native.paths, mirrorError: null };
    });
    native.tail = job.catch(() => {});
    return job;
  },
  osClipboardSnapshot: async () => {
    await native.tail;
    return { revision: native.revision, entries: native.entries,
      operation: native.operation, paths: native.paths, mirrorError: null };
  },
  osClipboardCompareAndClear: async (revision: number) => {
    if (revision !== native.revision || !native.entries) return false;
    native.revision++;
    native.entries = null;
    native.operation = null;
    return true;
  },
  osClipboardClaimCut: async (revision: number) => {
    await native.tail;
    if (revision !== native.revision || native.operation !== "cut" || native.lease === revision) return false;
    native.lease = revision;
    return true;
  },
  osClipboardReleaseCut: async (revision: number) => {
    if (revision !== native.revision || native.lease !== revision) return false;
    native.lease = null;
    return true;
  },
  osClipboardRekey: vi.fn(async () => null),
}));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: { error: vi.fn() } }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (_name: string, payload: { revision: number }) => {
    for (const listener of listeners) listener({ payload });
  }),
  listen: vi.fn(async (_name: string, listener: (event: { payload: { revision: number } }) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }),
}));

function entry(name: string): FileEntry {
  return { name, path: `/${name}`, kind: "file", size: 1, modified: "2026-09-30T00:00:00.000Z" };
}

it("two windows converge on the newer accepted copy while native writes execute in order", async () => {
  listeners.clear();
  native.revision++;
  native.entries = null;
  native.paths = [];
  native.operation = null;
  native.tail = Promise.resolve();
  native.writes = [];
  vi.resetModules();
  const a = (await import("$lib/state/clipboard.svelte")).clipboardStore;
  vi.resetModules();
  const b = (await import("$lib/state/clipboard.svelte")).clipboardStore;
  try {
    const older = a.copy([entry("older.txt")]);
    const newer = b.copy([entry("newer.txt")]);
    const reading = a.readOsFiles();
    await vi.waitFor(() => expect(native.writes).toHaveLength(1));
    native.writes[0].finish();
    await vi.waitFor(() => expect(native.writes).toHaveLength(2));
    native.writes[1].finish();
    await Promise.all([older, newer]);
    expect((await reading).content?.paths).toEqual(["/newer.txt"]);
    await vi.waitFor(() => expect(a.content?.entries[0].path).toBe("/newer.txt"));
    expect(b.content?.entries[0].path).toBe("/newer.txt");
    expect((await a.readOsFiles()).content?.paths).toEqual(["/newer.txt"]);
  } finally { a.destroy(); b.destroy(); }
});

function resetNative(): void {
  listeners.clear();
  native.revision++;
  native.entries = null;
  native.operation = null;
  native.paths = [];
  native.tail = Promise.resolve();
  native.writes = [];
  native.lease = null;
}

async function publishCut(store: { cut(entries: FileEntry[]): Promise<boolean>; revision: number }, name: string) {
  const cut = store.cut([entry(name)]);
  await vi.waitFor(() => expect(native.writes.length).toBeGreaterThan(0));
  native.writes.at(-1)!.finish();
  await cut;
  return store.revision;
}

it("only one window moves a given Cut (#871)", async () => {
  resetNative();
  vi.resetModules();
  const a = (await import("$lib/state/clipboard.svelte")).clipboardStore;
  vi.resetModules();
  const b = (await import("$lib/state/clipboard.svelte")).clipboardStore;
  try {
    const revision = await publishCut(a, "cut.txt");
    await vi.waitFor(() => expect(b.revision).toBe(revision));
    const moves: string[] = [];
    let finishMove!: () => void;
    const moving = new Promise<void>((resolve) => { finishMove = resolve; });
    const pasteInA = a.withCutClaim(revision, async () => {
      moves.push("a");
      await moving;
      return { result: "a", complete: true };
    });
    await vi.waitFor(() => expect(moves).toEqual(["a"]));
    const pasteInB = await b.withCutClaim(revision, async () => {
      moves.push("b");
      return { result: "b", complete: true };
    });
    finishMove();

    expect(pasteInB).toEqual({ claimed: false });
    expect(await pasteInA).toEqual({ claimed: true, result: "a" });
    expect(moves).toEqual(["a"]);
    expect(native.entries).toBeNull();
    // Once consumed, a later paste of the same revision is also refused.
    expect(await b.withCutClaim(revision, async () => ({ result: "b", complete: true })))
      .toEqual({ claimed: false });
  } finally { a.destroy(); b.destroy(); }
});

it("an unfinished Cut move returns the Cut so another paste can complete it", async () => {
  resetNative();
  vi.resetModules();
  const store = (await import("$lib/state/clipboard.svelte")).clipboardStore;
  try {
    const revision = await publishCut(store, "cut.txt");
    expect(await store.withCutClaim(revision, async () => ({ result: "partial", complete: false })))
      .toEqual({ claimed: true, result: "partial" });
    expect(native.operation).toBe("cut");
    await expect(store.withCutClaim(revision, async () => { throw new Error("move failed"); }))
      .rejects.toThrow("move failed");
    expect(native.operation).toBe("cut");
    expect(await store.withCutClaim(revision, async () => ({ result: "done", complete: true })))
      .toEqual({ claimed: true, result: "done" });
    expect(native.entries).toBeNull();
  } finally { store.destroy(); }
});

it("a Copy is never claimed as a Cut", async () => {
  resetNative();
  vi.resetModules();
  const store = (await import("$lib/state/clipboard.svelte")).clipboardStore;
  try {
    const copy = store.copy([entry("copy.txt")]);
    await vi.waitFor(() => expect(native.writes).toHaveLength(1));
    native.writes[0].finish();
    await copy;
    const move = vi.fn(async () => ({ result: null, complete: true }));
    expect(await store.withCutClaim(store.revision, move)).toEqual({ claimed: false });
    expect(move).not.toHaveBeenCalled();
  } finally { store.destroy(); }
});

it("a Cut completion cannot clear a newer clipboard revision", async () => {
  resetNative();
  vi.resetModules();
  const store = (await import("$lib/state/clipboard.svelte")).clipboardStore;
  try {
    const oldRevision = await publishCut(store, "cut.txt");
    await store.withCutClaim(oldRevision, async () => {
      // Another window copies while this paste is still moving the Cut.
      const copy = store.copy([entry("copy.txt")]);
      await vi.waitFor(() => expect(native.writes).toHaveLength(2));
      native.writes[1].finish();
      await copy;
      return { result: null, complete: true };
    });
    expect((native.entries as FileEntry[] | null)?.[0]?.path).toBe("/copy.txt");
  } finally { store.destroy(); }
});

it("an older local completion cannot replace a newer pending Copy", async () => {
  native.revision++;
  native.entries = null;
  native.operation = null;
  native.paths = [];
  native.tail = Promise.resolve();
  native.writes = [];
  vi.resetModules();
  const store = (await import("$lib/state/clipboard.svelte")).clipboardStore;
  try {
    const older = store.copy([entry("older.txt")]);
    const newer = store.copy([entry("newer.txt")]);
    await vi.waitFor(() => expect(native.writes).toHaveLength(1));
    native.writes[0].finish();
    await vi.waitFor(() => expect(native.writes).toHaveLength(2));
    expect(store.content?.entries[0].path).toBe("/newer.txt");
    native.writes[1].finish();
    await Promise.all([older, newer]);
    expect(store.content?.entries[0].path).toBe("/newer.txt");
  } finally { store.destroy(); }
});
