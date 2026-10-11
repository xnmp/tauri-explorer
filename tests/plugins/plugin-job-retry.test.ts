/**
 * Plugin job Retry through a plugin's own context (capability "jobRetry"):
 * jobs record their plugin, a retired plugin's entries stop offering Retry,
 * and a retry that cannot start is always announced. Drives the real
 * window controller and jobs store; only Tauri's event source is faked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => { if (handlers.get(name) === handler) handlers.delete(name); };
  },
}));

import { createPluginContext } from "$lib/plugins/api";
import { jobsStore } from "$lib/state/jobs.svelte";
import { toastStore } from "$lib/state/toast.svelte";

afterEach(() => {
  for (const job of [...jobsStore.jobs]) jobsStore.removeJob(job.id);
  vi.restoreAllMocks();
});

const fail = (kind: string, jobId: number, error: string) => handlers.get(`${kind}-error`)!({ payload: { jobId, error } });
const entry = (id: number) => jobsStore.jobs.find((job) => job.id === id);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("plugin-scoped job retry", () => {
  it("records the plugin and drops Retry from its entries when it is retired", async () => {
    const trace = createPluginContext("trace");
    const other = createPluginContext("other");
    const retry = vi.fn(async () => ({ ok: true as const, data: 0 }));
    await trace.ctx.jobs.accept({ kind: "trace-image", label: "a.png", detail: "d", presentation: "image", retry }, async () => ({ ok: true, data: 501 }));
    await trace.ctx.jobs.accept({ kind: "trace-image", label: "b.png", detail: "d", presentation: "image", retry }, async () => ({ ok: true, data: 502 }));
    await other.ctx.jobs.accept({ kind: "other-image", label: "c.png", detail: "d", presentation: "image", retry }, async () => ({ ok: true, data: 601 }));
    fail("trace-image", 501, "refused");
    fail("other-image", 601, "refused");
    expect(entry(501)).toMatchObject({ owner: "trace", status: "error" });
    expect(typeof entry(501)?.retry).toBe("function");

    trace.dispose();
    // Failed and still-running entries of the retired plugin lose Retry...
    expect(entry(501)?.retry).toBeUndefined();
    expect(entry(502)?.retry).toBeUndefined();
    fail("trace-image", 502, "refused");
    expect(entry(502)).toMatchObject({ status: "error" });
    expect(entry(502)?.retry).toBeUndefined();
    expect(await jobsStore.retryJob(501)).toBeNull();
    expect(retry).not.toHaveBeenCalled();
    // ...while another plugin's keep it.
    expect(typeof entry(601)?.retry).toBe("function");
    other.dispose();
  });

  it("does not attach Retry to a job a retired context accepts later", async () => {
    const trace = createPluginContext("late");
    const start = deferred<{ ok: true; data: number }>();
    const accepted = trace.ctx.jobs.accept({ kind: "late-image", label: "a.png", detail: "d", retry: async () => ({ ok: true, data: 0 }) }, () => start.promise);
    await vi.waitFor(() => expect(handlers.has("late-image-error")).toBe(true));
    trace.dispose();
    start.resolve({ ok: true, data: 701 });
    await accepted;
    expect(entry(701)?.retry).toBeUndefined();
  });

  it("announces a retry that cannot start, even after its entry is gone", async () => {
    const errors = vi.spyOn(toastStore, "error").mockImplementation(() => 0);
    const trace = createPluginContext("announce");
    const result = deferred<{ ok: false; error: string }>();
    await trace.ctx.jobs.accept({ kind: "announce-image", label: "lantern.png", detail: "d", presentation: "image", retry: () => result.promise }, async () => ({ ok: true, data: 801 }));
    fail("announce-image", 801, "Codex replied with a refusal");
    expect(errors).toHaveBeenLastCalledWith("lantern.png failed: Codex replied with a refusal");

    const retrying = jobsStore.retryJob(801);
    jobsStore.removeJob(801); // e.g. torn down while the retry starts
    result.resolve({ ok: false, error: "Rate limited" });
    expect(await retrying).toBeNull();
    expect(errors).toHaveBeenLastCalledWith("lantern.png failed: Rate limited");
    expect(entry(801)).toBeUndefined();
    trace.dispose();
  });

  it("announces a rejected retry and shows it on the entry", async () => {
    const errors = vi.spyOn(toastStore, "error").mockImplementation(() => 0);
    const trace = createPluginContext("reject");
    await trace.ctx.jobs.accept({ kind: "reject-image", label: "a.png", detail: "d", retry: async () => { throw new Error("Provider offline"); } }, async () => ({ ok: true, data: 901 }));
    fail("reject-image", 901, "refused");
    await jobsStore.retryJob(901);
    expect(errors).toHaveBeenLastCalledWith("a.png failed: Provider offline");
    expect(entry(901)).toMatchObject({ status: "error", error: "Provider offline", retrying: false });
    trace.dispose();
  });
});
