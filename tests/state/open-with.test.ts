import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "$lib/api/common";
import type { OpenWithApplication } from "$lib/domain/open-with";

const api = vi.hoisted(() => ({ list: vi.fn(), launch: vi.fn() }));
vi.mock("$lib/api/open", () => ({ listOpenWithApplications: api.list, openFileWithApplication: api.launch }));
import { createOpenWithStore } from "$lib/state/open-with.svelte";

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const applications = [{ id: "alternate.desktop", name: "Alternate Editor" }];
const ok = { ok: true, data: applications } as const;

describe("installed application choice", () => {
  beforeEach(() => { vi.clearAllMocks(); api.list.mockResolvedValue(ok); api.launch.mockResolvedValue({ ok: true }); });

  it("captures an intact file path and launches only the chosen application", async () => {
    const store = createOpenWithStore();
    const path = "/a space/ü ' $(touch bad).txt";
    await store.open(path);
    await store.choose("alternate.desktop");
    expect(api.list).toHaveBeenCalledWith(path);
    expect(api.launch).toHaveBeenCalledExactlyOnceWith(path, "alternate.desktop");
    expect(store.isOpen).toBe(false);
  });

  it("closing while loading cannot launch or reopen when the catalogue arrives", async () => {
    const result = deferred<ApiResult<OpenWithApplication[]>>();
    api.list.mockReturnValue(result.promise);
    const store = createOpenWithStore();
    const opening = store.open("/a.txt");
    store.close();
    result.resolve(ok);
    await opening;
    await store.choose("alternate.desktop");
    expect(store.isOpen).toBe(false);
    expect(api.launch).not.toHaveBeenCalled();
  });

  it("reopening for another file discards the earlier late catalogue", async () => {
    const older = deferred<ApiResult<OpenWithApplication[]>>();
    api.list.mockReturnValueOnce(older.promise);
    const store = createOpenWithStore();
    const opening = store.open("/old.txt");
    await store.open("/new.txt");
    older.resolve({ ok: false, error: "old failure" });
    await opening;
    expect(store.path).toBe("/new.txt");
    expect(store.error).toBeNull();
    await store.choose("alternate.desktop");
    expect(api.launch).toHaveBeenCalledWith("/new.txt", "alternate.desktop");
  });

  it("an unlisted application cannot launch", async () => {
    const store = createOpenWithStore();
    await store.open("/a.txt");
    await store.choose("arbitrary command");
    expect(api.launch).not.toHaveBeenCalled();
    expect(store.isOpen).toBe(true);
  });

  it("a pending launch prevents duplicate dispatch and retargeting", async () => {
    const pending = deferred<ApiResult<void>>();
    api.launch.mockReturnValue(pending.promise);
    const store = createOpenWithStore();
    await store.open("/a.txt");
    const launching = store.choose("alternate.desktop");
    await store.choose("alternate.desktop");
    await store.open("/b.txt");
    expect(api.launch).toHaveBeenCalledExactlyOnceWith("/a.txt", "alternate.desktop");
    expect(store.path).toBe("/a.txt");
    pending.resolve({ ok: false, error: "application unavailable" });
    await launching;
    expect(store.isOpen).toBe(true);
    expect(store.error).toBe("application unavailable");
  });

  it("a close request cannot cancel an accepted launch or permit a second dispatch", async () => {
    const pending = deferred<ApiResult<void>>();
    api.launch.mockReturnValue(pending.promise);
    const store = createOpenWithStore();
    await store.open("/a.txt");
    const launching = store.choose("alternate.desktop");
    store.close();
    expect(store.isOpen).toBe(true);
    await store.open("/b.txt");
    await store.choose("alternate.desktop");
    expect(api.launch).toHaveBeenCalledExactlyOnceWith("/a.txt", "alternate.desktop");
    pending.resolve({ ok: false, error: "late launch error" });
    await launching;
    expect(store.isOpen).toBe(true);
    expect(store.error).toBe("late launch error");
    store.close();
    expect(store.isOpen).toBe(false);
  });

  it("missing applications and catalogue failures remain cancellable without launching", async () => {
    const store = createOpenWithStore();
    api.list.mockResolvedValueOnce({ ok: true, data: [] });
    await store.open("/a.txt");
    expect(store.applications).toEqual([]);
    store.close();
    api.list.mockResolvedValueOnce({ ok: false, error: "file was deleted" });
    await store.open("/a.txt");
    expect(store.error).toBe("file was deleted");
    store.close();
    expect(api.launch).not.toHaveBeenCalled();
  });
});
