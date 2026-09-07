import { describe, expect, it, vi } from "vitest";
import { createPluginJobsController } from "$lib/state/plugin-jobs";

function fixture() {
  const handlers = new Map<string, (payload: any) => void>();
  const added: any[] = [];
  const completed: any[] = [];
  const failed: any[] = [];
  const successes: string[] = [];
  const errors: string[] = [];
  let refreshes = 0;
  const unlisten = vi.fn();
  const controller = createPluginJobsController({
    listen: async (name, handler) => {
      handlers.set(name, handler);
      return unlisten;
    },
    add: (job) => added.push(job),
    complete: (id, outputPath) => completed.push({ id, outputPath }),
    fail: (id, error) => failed.push({ id, error }),
    success: (message) => successes.push(message),
    error: (message) => errors.push(message),
    refresh: async () => { refreshes += 1; },
  });
  return { controller, handlers, added, completed, failed, successes, errors, unlisten, get refreshes() { return refreshes; } };
}

describe("window-owned plugin jobs", () => {
  it("reconciles completion before invoke returns the job id", async () => {
    const f = fixture();
    await f.controller.init();
    const result = await f.controller.accept(
      { kind: "upscale", label: "source.png", detail: "2x" },
      async () => {
        f.handlers.get("upscale-complete")!({ jobId: 1, outputPath: "/out/result.png" });
        return { ok: true, data: 1 };
      },
    );

    expect(result).toEqual({ ok: true, data: 1 });
    expect(f.added).toHaveLength(1);
    expect(f.completed).toEqual([{ id: 1, outputPath: "/out/result.png" }]);
    expect(f.successes).toEqual(["Upscale complete: result.png"]);
    expect(f.refreshes).toBe(1);
  });

  it("owns accepted jobs independently of plugin activation and ignores duplicate terminal events", async () => {
    const f = fixture();
    await f.controller.init();
    f.controller.register({ kind: "nano-banana", id: 2, label: "source.png", detail: "edit" });

    f.handlers.get("nano-banana-complete")!({ jobId: 2, outputPath: "/out/edit.png" });
    f.handlers.get("nano-banana-error")!({ jobId: 2, error: "late" });

    expect(f.completed).toHaveLength(1);
    expect(f.failed).toHaveLength(0);
    expect(f.successes).toHaveLength(1);
  });

  it("does not create presentation for a failed start that never registers", async () => {
    const f = fixture();
    const result = await f.controller.accept(
      { kind: "upscale", label: "source.png", detail: "2x" },
      async () => ({ ok: false, error: "no key" }),
    );
    expect(result).toEqual({ ok: false, error: "no key" });
    expect(f.added).toEqual([]);
    expect(f.completed).toEqual([]);
    expect(f.failed).toEqual([]);
  });

  it("drains late listener acquisition and rejects callbacks after disposal", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handlers: ((payload: any) => void)[] = [];
    const unlisten = vi.fn();
    const complete = vi.fn();
    const controller = createPluginJobsController({
      listen: async (_name, handler) => { handlers.push(handler); await gate; return unlisten; },
      add: vi.fn(), complete, fail: vi.fn(), success: vi.fn(), error: vi.fn(), refresh: async () => {},
    });
    const starting = controller.init();
    const stopping = controller.dispose();
    release();
    const [startResult] = await Promise.allSettled([starting, stopping]);
    expect(startResult.status).toBe("rejected");
    handlers.forEach((handler) => handler({ jobId: 3, outputPath: "/late.png" }));

    expect(unlisten).toHaveBeenCalledTimes(4);
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not launch work when disposal wins listener acquisition", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const start = vi.fn(async () => ({ ok: true as const, data: 9 }));
    const controller = createPluginJobsController({
      listen: async () => { await gate; return () => {}; },
      add: vi.fn(), complete: vi.fn(), fail: vi.fn(), success: vi.fn(), error: vi.fn(), refresh: async () => {},
    });
    const accepting = controller.accept(
      { kind: "upscale", label: "source.png", detail: "2x" },
      start,
    );
    const stopping = controller.dispose();
    release();

    const [result] = await Promise.all([accepting, stopping]);
    expect(result).toMatchObject({ ok: false });
    expect(start).not.toHaveBeenCalled();
  });

  it("cleans partial listener acquisition and does not start without event ownership", async () => {
    const unlisten = vi.fn();
    const start = vi.fn(async () => ({ ok: true as const, data: 4 }));
    let call = 0;
    const controller = createPluginJobsController({
      listen: async () => {
        call += 1;
        if (call === 3) throw new Error("listener unavailable");
        return unlisten;
      },
      add: vi.fn(), complete: vi.fn(), fail: vi.fn(), success: vi.fn(), error: vi.fn(), refresh: async () => {},
    });

    const result = await controller.accept(
      { kind: "upscale", label: "source.png", detail: "2x" },
      start,
    );

    expect(result).toMatchObject({ ok: false });
    expect(start).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(3);
  });

  it("drains an in-flight start before ending listener ownership", async () => {
    const f = fixture();
    await f.controller.init();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const accepting = f.controller.accept(
      { kind: "upscale", label: "source.png", detail: "2x" },
      async () => { markStarted(); await gate; return { ok: true, data: 10 }; },
    );
    await started;
    const disposing = f.controller.dispose();
    release();
    await Promise.all([accepting, disposing]);

    expect(f.added).toHaveLength(1);
  });

  it("is terminal after its owning window disposes", async () => {
    const f = fixture();
    await f.controller.init();
    await f.controller.dispose();
    await expect(f.controller.init()).rejects.toThrow("disposed");
  });

  it("keeps exactly-once presentation through long accepted-job churn", async () => {
    const f = fixture();
    await f.controller.init();

    for (let id = 1; id <= 5_000; id += 1) {
      f.controller.register({ kind: "upscale", id, label: `source-${id}.png`, detail: "2x" });
      f.handlers.get("upscale-complete")!({ jobId: id, outputPath: `/out/${id}.png` });
    }
    f.handlers.get("upscale-complete")!({ jobId: 5_000, outputPath: "/out/duplicate.png" });

    expect(f.added).toHaveLength(5_000);
    expect(f.completed).toHaveLength(5_000);
    expect(f.successes).toHaveLength(5_000);
    expect(f.refreshes).toBe(5_000);
  });
});
