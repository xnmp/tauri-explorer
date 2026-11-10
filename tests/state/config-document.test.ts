/**
 * The shared config-file lifecycle behind bookmarks.json and folder-views.json:
 * first load (with localStorage migration), external-edit reload, write-through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readConfigFileMock = vi.fn();
const writeConfigFileMock = vi.fn();

vi.mock("$lib/api/config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readConfigFile: (...args: unknown[]) => readConfigFileMock(...args),
  writeConfigFile: (...args: unknown[]) => writeConfigFileMock(...args),
}));

type List = string[];
const FILE = "list.json";
const KEY = "test-list";
const WRITER = "list-store";

async function fresh(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  const { createConfigDocument } = await import("$lib/state/config-document");
  const persisted = await import("$lib/state/persisted");
  let value: List = persisted.loadPersisted<List>(KEY, []);
  const doc = createConfigDocument<List>({
    file: FILE,
    key: KEY,
    writer: WRITER,
    get: () => value,
    set: (v) => (value = v),
    acceptOnInit: (p): p is List => Array.isArray(p) && p.length > 0,
    acceptOnReload: (p): p is List => Array.isArray(p),
    migration: () => (value.length > 0 ? value : null),
    ...overrides,
  });
  return {
    doc,
    value: () => value,
    setValue: (v: List) => (value = v),
    settle: () =>
      vi.waitFor(() =>
        expect(persisted.configWriteActivity(FILE, WRITER).pending).toBe(false),
      ),
  };
}

const readOk = (data: string) =>
  readConfigFileMock.mockResolvedValue({ ok: true, data });
const written = () =>
  writeConfigFileMock.mock.calls.map((c) => JSON.parse(c[1] as string));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  readConfigFileMock.mockResolvedValue({ ok: true, data: "" });
  writeConfigFileMock.mockResolvedValue({ ok: true, data: undefined });
});

describe("init", () => {
  it("adopts a valid config file and refreshes the cache without rewriting it", async () => {
    const t = await fresh();
    readOk(JSON.stringify(["a", "b"]));
    await t.doc.init();
    expect(t.value()).toEqual(["a", "b"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a", "b"]);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("migrates the cache into a missing config file, keeping the cache", async () => {
    localStorage.setItem(KEY, JSON.stringify(["cached"]));
    const t = await fresh();
    readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
    await t.doc.init();
    await t.settle();
    expect(t.value()).toEqual(["cached"]);
    expect(written()).toEqual([["cached"]]);
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it("migrates over an empty file", async () => {
    localStorage.setItem(KEY, JSON.stringify(["cached"]));
    const t = await fresh();
    readOk("");
    await t.doc.init();
    await t.settle();
    expect(written()).toEqual([["cached"]]);
  });

  it("migrates over malformed JSON instead of discarding the cache", async () => {
    localStorage.setItem(KEY, JSON.stringify(["cached"]));
    const t = await fresh();
    readOk("{ not json");
    await t.doc.init();
    await t.settle();
    expect(t.value()).toEqual(["cached"]);
    expect(written()).toEqual([["cached"]]);
  });

  it("treats a rejected shape as absent", async () => {
    localStorage.setItem(KEY, JSON.stringify(["cached"]));
    const t = await fresh();
    readOk(JSON.stringify({ not: "a list" }));
    await t.doc.init();
    await t.settle();
    expect(t.value()).toEqual(["cached"]);
    expect(written()).toEqual([["cached"]]);
  });

  it("writes nothing when neither file nor cache has data", async () => {
    const t = await fresh();
    await t.doc.init();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
    expect(t.value()).toEqual([]);
  });

  it("migrates whatever value the file's migration option supplies", async () => {
    localStorage.setItem(KEY, JSON.stringify(["stored"]));
    const stor = await fresh({
      migration: () => JSON.parse(localStorage.getItem(KEY)!) as List,
    });
    stor.setValue(["live"]);
    await stor.doc.init();
    await stor.settle();
    expect(written()).toEqual([["stored"]]);
  });

  it("writes nothing when the migration option reports nothing to migrate", async () => {
    const t = await fresh({ migration: () => null });
    t.setValue(["live"]);
    await t.doc.init();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });
});

describe("reload", () => {
  it("adopts an external change and refreshes the cache", async () => {
    const t = await fresh();
    t.setValue(["a"]);
    readOk(JSON.stringify(["a", "b"]));
    expect(await t.doc.reload()).toBe("external-change");
    expect(t.value()).toEqual(["a", "b"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["a", "b"]);
  });

  it("ignores content identical to memory", async () => {
    const t = await fresh();
    t.setValue(["a"]);
    readOk(JSON.stringify(["a"], null, 4));
    expect(await t.doc.reload()).toBe("unchanged");
    expect(t.value()).toEqual(["a"]);
  });

  it("ignores our own write coming back", async () => {
    const t = await fresh();
    t.setValue(["a"]);
    t.setValue(["a", "mine"]);
    t.doc.save();
    await t.settle();
    t.setValue(["a", "mine", "newer"]);
    readOk(JSON.stringify(["a", "mine"], null, 2));
    expect(await t.doc.reload()).toBe("own-write-echo");
    expect(t.value()).toEqual(["a", "mine", "newer"]);
  });

  it("ignores a read that raced a write of ours", async () => {
    const t = await fresh();
    t.setValue(["a"]);
    let release!: (v: unknown) => void;
    readConfigFileMock.mockReturnValue(new Promise((r) => (release = r)));
    const pending = t.doc.reload();
    t.setValue(["a", "mine"]);
    t.doc.save();
    release({ ok: true, data: JSON.stringify(["stale"]) });
    expect(await pending).toBe("self-write-overlap");
    expect(t.value()).toEqual(["a", "mine"]);
  });

  it("keeps current state for malformed, wrong-shape, or unreadable files", async () => {
    const t = await fresh();
    t.setValue(["a"]);
    readOk("{ nope");
    expect(await t.doc.reload()).toBe("unusable");
    readOk(JSON.stringify({ a: 1 }));
    expect(await t.doc.reload()).toBe("unusable");
    readOk("");
    expect(await t.doc.reload()).toBe("unusable");
    readConfigFileMock.mockResolvedValue({ ok: false, error: "gone" });
    expect(await t.doc.reload()).toBe("unusable");
    expect(t.value()).toEqual(["a"]);
  });

  it("applies a stricter reload gate than init when configured", async () => {
    const t = await fresh({
      acceptOnReload: (p: unknown) => Array.isArray(p) && p.length > 1,
    });
    t.setValue(["a"]);
    readOk(JSON.stringify(["b"]));
    expect(await t.doc.reload()).toBe("unusable");
  });
});

describe("save", () => {
  it("writes through to the cache and the config file as indented JSON", async () => {
    const t = await fresh();
    t.setValue(["x"]);
    t.doc.save();
    await t.settle();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["x"]);
    expect(writeConfigFileMock).toHaveBeenCalledWith(
      FILE,
      JSON.stringify(["x"], null, 2),
    );
  });

  it("survives a failing config write without throwing and keeps the cache", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await fresh();
    writeConfigFileMock.mockResolvedValue({ ok: false, error: "disk full" });
    t.setValue(["x"]);
    expect(() => t.doc.save()).not.toThrow();
    await t.settle();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["x"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
