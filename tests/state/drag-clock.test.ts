import { afterEach, expect, it, vi } from "vitest";
import { createDragClock } from "$lib/state/drag-clock";

afterEach(() => vi.restoreAllMocks());

it.each(["backward", "forward"])("native clock correlation survives a %s wall correction and a new renderer", async direction => {
  let perf = 10, native = 100;
  let wall = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  const clock = createDragClock(async () => ({ id: "runtime", now: native }), () => ({ timeOrigin: wall, now: () => perf }));
  await clock.initialize();
  expect(clock.stamp().at).toBe(100);
  wall += direction === "backward" ? -500_000 : 500_000;
  perf += 10; native += 10;
  expect(clock.stamp().at).toBe(110);
  // A renderer created after the correction has a different performance epoch,
  // yet its sample puts observations in the same native process clock.
  let peerPerf = 5;
  const peer = createDragClock(async () => ({ id: "runtime", now: native }), () => ({ timeOrigin: wall, now: () => peerPerf }));
  await peer.initialize();
  perf += 5; peerPerf += 5;
  expect(peer.stamp().clockId).toBe(clock.stamp().clockId);
  expect(peer.stamp().at).toBe(clock.stamp().at);
});

it("retains request latency as an interval containing the real native observation", async () => {
  let perf = 10;
  let receive!: (value: { id: string; now: number }) => void;
  const clock = createDragClock(() => new Promise(resolve => { receive = resolve; }), () => ({ timeOrigin: 0, now: () => perf }));
  const initialized = clock.initialize();
  // Request reaches native at perf=12, response arrives at perf=20. No midpoint
  // assumption can place the exact sample in an asynchronous delivery channel.
  perf = 20; receive({ id: "runtime", now: 100 }); await initialized;
  perf = 25;
  const stamp = clock.stamp();
  const actualNativeNow = 113;
  expect(stamp.at).toBeLessThanOrEqual(actualNativeNow);
  expect(stamp.at + stamp.uncertainty).toBeGreaterThanOrEqual(actualNativeNow);
});

it.each([undefined, { id: "", now: 1 }, { id: "runtime", now: NaN }, { id: "runtime", now: -1 }])("invalid calibration fails closed and permits retry: %j", async invalid => {
  const read = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValue({ id: "valid", now: 1 });
  const clock = createDragClock(read, () => ({ timeOrigin: 0, now: () => 0 }));
  await expect(clock.initialize()).rejects.toThrow("Invalid drag clock sample");
  await clock.initialize();
  expect(clock.stamp().clockId).toBe("valid");
});
