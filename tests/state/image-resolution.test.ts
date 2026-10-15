import { expect, test, vi } from "vitest";
import { createResolutionQueue, observeResolution } from "$lib/state/image-resolution";

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
test("reads stay bounded and scrolled-away queued rows never read", async () => {
  const pending: ((value: null) => void)[] = [];
  const read = vi.fn((_path: string) => new Promise<null>(resolve => pending.push(resolve)));
  const queue = createResolutionQueue(read, 2);
  const publish = vi.fn();
  queue.request("first", publish); queue.request("second", publish);
  const gone = queue.request("gone", publish);
  queue.request("last", publish); gone.cancel();
  await flush();
  expect(read.mock.calls).toHaveLength(2);
  pending[0](null); await flush();
  expect(read.mock.calls.map(call => call[0])).toEqual(["first", "second", "last"]);
  pending[1](null); pending[2](null); await flush();
  expect(publish).toHaveBeenCalledTimes(3);
});
test("a replaced row cannot publish a late result and rereads the same path", async () => {
  let finish!: (value: { width: number; height: number }) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ width: 1200, height: 800 });
  const queue = createResolutionQueue(read, 1);
  const old = vi.fn(), current = vi.fn();
  const request = queue.request("photo.png", old); await flush(); request.cancel();
  queue.request("photo.png", current);
  finish({ width: 10, height: 20 }); await flush();
  expect(old).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledWith({ width: 1200, height: 800 });
  expect(read).toHaveBeenCalledTimes(2);
});
test("failed reads show unavailable metadata and release their slot", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("unreadable")).mockResolvedValue(null);
  const publish = vi.fn(); const queue = createResolutionQueue(read, 1);
  queue.request("bad.png", publish); queue.request("next.png", publish); await vi.waitFor(() => expect(publish.mock.calls).toEqual([[null], [null]]));
});

test("change events reread unchanged entry paths and disposal removes observation", async () => {
  const read = vi.fn().mockResolvedValueOnce({ width: 100, height: 50 }).mockResolvedValue({ width: 400, height: 200 });
  const publish = vi.fn(), unsubscribe = vi.fn();
  let invalidate!: () => void;
  const stop = observeResolution(createResolutionQueue(read, 1), "same.png", publish, callback => { invalidate = callback; return unsubscribe; });
  await flush(); expect(publish).toHaveBeenLastCalledWith({ width: 100, height: 50 });
  invalidate(); await flush(); expect(publish).toHaveBeenLastCalledWith({ width: 400, height: 200 });
  stop(); invalidate(); await flush();
  expect(read).toHaveBeenCalledTimes(2); expect(unsubscribe).toHaveBeenCalledOnce();
});
