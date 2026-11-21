/** `ctx.agent` (#1884): host request IDs, pass-through requests, abort and
 *  deactivation cancel native jobs, and native errors reach the plugin. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  describeAgent: vi.fn(),
  runAgent: vi.fn(),
  cancelAgent: vi.fn(),
}));
vi.mock("$lib/api/ai-agent", () => native);

import { createPluginContext } from "$lib/plugins/api";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";
import type { AgentRequest } from "$lib/domain/ai-agent";

/** A native job that settles only when the test says so. */
function pendingJob() {
  let settle!: { resolve: (value: unknown) => void; reject: (error: unknown) => void };
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return { promise, ...settle };
}
const request: AgentRequest = {
  folder: "/home/u/invoices", instructions: "For every file, find the invoice date", input: "[\"a.pdf\",\"b.pdf\"]",
  model: "haiku", maxOutputTokens: 4096, timeoutMs: 180_000, expectedConfigurationRevision: 3,
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const disposers: (() => void)[] = [];
function plugin(id = "acme.columns") {
  const handle = createPluginContext(id, id);
  disposers.push(handle.dispose);
  return handle;
}
/** The panes open in this window's tabs. */
let openPanes: string[] = [];
beforeEach(() => {
  openPanes = ["/home/u/elsewhere", "/home/u/invoices/"];
  vi.spyOn(windowTabsManager, "getAllExplorers").mockImplementation(
    () => openPanes.map((currentPath) => ({ currentPath })) as unknown as ReturnType<typeof windowTabsManager.getAllExplorers>,
  );
  native.cancelAgent.mockReset().mockResolvedValue(true);
  native.runAgent.mockReset();
  native.describeAgent.mockReset();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
});

describe("ctx.agent", () => {
  it("passes the request through unchanged with a host-generated, plugin-scoped ID", async () => {
    const result = { text: "{}", model: "haiku" };
    native.runAgent.mockResolvedValue(result);
    const { ctx } = plugin();
    await expect(ctx.agent!.run(request)).resolves.toBe(result);
    const [sent] = native.runAgent.mock.calls[0];
    const { requestId, ...rest } = sent;
    expect(rest).toEqual(request);
    expect(requestId).toMatch(/^agent\.acme\.columns\.[a-z0-9]+\.1$/);
    await ctx.agent!.run(request);
    expect(native.runAgent.mock.calls[1][0].requestId).not.toBe(requestId);
  });

  it("gives a reactivated plugin fresh request IDs", async () => {
    native.runAgent.mockResolvedValue({ text: "{}", model: "haiku" });
    await plugin().ctx.agent!.run(request);
    await plugin().ctx.agent!.run(request);
    const [first, second] = native.runAgent.mock.calls.map(([sent]) => sent.requestId);
    expect(first).not.toBe(second);
  });

  it("cancels the native job when the signal aborts, and the run settles with native's outcome", async () => {
    const job = pendingJob();
    native.runAgent.mockReturnValue(job.promise);
    const { ctx } = plugin();
    const controller = new AbortController();
    const run = ctx.agent!.run(request, controller.signal);
    const { requestId } = native.runAgent.mock.calls[0][0];
    expect(native.cancelAgent).not.toHaveBeenCalled();
    controller.abort();
    expect(native.cancelAgent).toHaveBeenCalledExactlyOnceWith(requestId);
    const cancelled = { code: "cancelled", message: "Text request was cancelled" };
    job.reject(cancelled);
    await expect(run).rejects.toBe(cancelled);
  });

  it("runs only in a folder open in one of this window's panes", async () => {
    native.runAgent.mockResolvedValue({ text: "{}", model: "haiku" });
    const { ctx } = plugin();
    for (const folder of ["/home/u/.ssh", "/home/u", "/home/u/invoices/2026", "/"]) {
      await expect(ctx.agent!.run({ ...request, folder })).rejects.toMatchObject({ code: "folder_not_open" });
    }
    expect(native.runAgent).not.toHaveBeenCalled();
    // Trailing separators do not matter; the pane list is read at run time.
    await expect(ctx.agent!.run(request)).resolves.toMatchObject({ text: "{}" });
    openPanes = ["/home/u/elsewhere"];
    await expect(ctx.agent!.run(request)).rejects.toMatchObject({ code: "folder_not_open" });
    expect(native.runAgent).toHaveBeenCalledTimes(1);
  });

  it("never starts a job for an already-aborted signal", async () => {
    const { ctx } = plugin();
    const controller = new AbortController();
    controller.abort();
    await expect(ctx.agent!.run(request, controller.signal)).rejects.toThrow();
    expect(native.runAgent).not.toHaveBeenCalled();
  });

  it("does not cancel a job that already settled when its signal aborts later", async () => {
    native.runAgent.mockResolvedValue({ text: "{}", model: "haiku" });
    const { ctx } = plugin();
    const controller = new AbortController();
    await ctx.agent!.run(request, controller.signal);
    controller.abort();
    expect(native.cancelAgent).not.toHaveBeenCalled();
  });

  it("cancels every running job on deactivation, and only those", async () => {
    const running = pendingJob();
    native.runAgent.mockResolvedValueOnce({ text: "{}", model: "haiku" }).mockReturnValueOnce(running.promise);
    const { ctx, dispose } = plugin();
    await ctx.agent!.run(request);
    const settledId = native.runAgent.mock.calls[0][0].requestId;
    const pending = ctx.agent!.run(request);
    const runningId = native.runAgent.mock.calls[1][0].requestId;
    dispose();
    expect(native.cancelAgent).toHaveBeenCalledExactlyOnceWith(runningId);
    expect(native.cancelAgent).not.toHaveBeenCalledWith(settledId);
    running.reject({ code: "cancelled", message: "Text request was cancelled" });
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(ctx.agent!.run(request)).rejects.toThrow("disposed");
    await expect(ctx.agent!.describe()).rejects.toThrow("disposed");
    expect(native.runAgent).toHaveBeenCalledTimes(2);
  });

  it("rejects with native errors unchanged, including a failed describe", async () => {
    const unsupported = { code: "unsupported", message: "Folder agent jobs need a Claude Code CLI or Codex CLI connection" };
    native.runAgent.mockRejectedValue(unsupported);
    native.describeAgent.mockRejectedValue(unsupported);
    const { ctx } = plugin();
    await expect(ctx.agent!.run(request)).rejects.toBe(unsupported);
    await expect(ctx.agent!.describe()).rejects.toBe(unsupported);
  });

  it("logs a failed cancel without hiding the job's own outcome", async () => {
    const job = pendingJob();
    native.runAgent.mockReturnValue(job.promise);
    native.cancelAgent.mockRejectedValue(new Error("IPC closed"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx } = plugin();
    const controller = new AbortController();
    const run = ctx.agent!.run(request, controller.signal);
    controller.abort();
    await flush();
    expect(errors).toHaveBeenCalled();
    job.resolve({ text: "late", model: "haiku" });
    await expect(run).resolves.toMatchObject({ text: "late" });
    errors.mockRestore();
  });
});
