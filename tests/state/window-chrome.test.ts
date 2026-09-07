import { expect, it, vi } from "vitest";
import { observeWindowChrome } from "$lib/state/window-chrome";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it("retiring chrome while its initial read waits cannot publish or leak a late subscription", async () => {
  const initial = deferred<boolean>();
  const stop = vi.fn();
  const publish = vi.fn();
  const source = { isMaximized: () => initial.promise, onResized: vi.fn(async () => stop) };
  const dispose = observeWindowChrome(source, publish);
  await flush();
  dispose();
  initial.resolve(true);
  await flush();
  expect(publish).not.toHaveBeenCalled();
  expect(source.onResized.mock.calls.length === 0 || stop.mock.calls.length === 1).toBe(true);
});

it("releases a resize listener acquired after retirement exactly once", async () => {
  const listener = deferred<() => void>();
  const stop = vi.fn();
  const source = { isMaximized: async () => false, onResized: () => listener.promise };
  const dispose = observeWindowChrome(source, () => {});
  await flush();
  dispose();
  listener.resolve(stop);
  await flush();
  expect(stop).toHaveBeenCalledOnce();
  dispose();
  expect(stop).toHaveBeenCalledOnce();
});

it("coalesces resize reads and never publishes a result invalidated by a later resize", async () => {
  const reads: ReturnType<typeof deferred<boolean>>[] = [];
  let resize!: () => void;
  const publish = vi.fn();
  const dispose = observeWindowChrome({
    isMaximized: () => { const read = deferred<boolean>(); reads.push(read); return read.promise; },
    onResized: async (callback) => { resize = callback; return () => {}; },
  }, publish);
  await flush();
  reads[0].resolve(false);
  await flush();
  publish.mockClear();
  for (let i = 0; i < 100; i++) resize();
  expect(reads).toHaveLength(2);
  reads[1].resolve(true);
  await flush();
  expect(publish).not.toHaveBeenCalled();
  expect(reads).toHaveLength(3);
  reads[2].resolve(false);
  await flush();
  expect(publish.mock.calls).toEqual([[false]]);
  dispose();
});

it("ignores delivered callbacks and read results after disposal", async () => {
  let resize!: () => void;
  const read = deferred<boolean>();
  const publish = vi.fn();
  const query = vi.fn(() => read.promise);
  const dispose = observeWindowChrome({
    isMaximized: query,
    onResized: async (callback) => { resize = callback; return () => {}; },
  }, publish);
  await flush();
  dispose();
  resize();
  read.resolve(true);
  await flush();
  expect(query).toHaveBeenCalledOnce();
  expect(publish).not.toHaveBeenCalled();
});

it("reports a failed read and accepts the next resize without a rejected background task", async () => {
  let resize!: () => void;
  const failure = new Error("native query failed");
  const query = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(true);
  const report = vi.fn();
  const publish = vi.fn();
  const dispose = observeWindowChrome({
    isMaximized: query,
    onResized: async (callback) => { resize = callback; return () => {}; },
  }, publish, report);
  await flush();
  expect(report.mock.calls).toEqual([[failure]]);
  resize();
  await flush();
  expect(publish.mock.calls).toEqual([[true]]);
  dispose();
});

it("observes asynchronous native unlisten failures during retirement", async () => {
  const failure = new Error("native unlisten failed");
  const report = vi.fn();
  const stop = vi.fn(async () => { throw failure; });
  const dispose = observeWindowChrome({
    isMaximized: async () => false,
    onResized: async () => stop,
  }, () => {}, report);
  await flush();
  dispose();
  dispose();
  await flush();
  expect(stop).toHaveBeenCalledOnce();
  expect(report.mock.calls).toEqual([[failure]]);
});
