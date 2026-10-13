import { afterEach, expect, it, vi } from "vitest";
import { dropClockCases } from "../helpers/drop-policy";

const native = vi.hoisted(() => ({ id: "runtime", now: 100, perf: 0 }));
vi.mock("$lib/api/common", () => ({ isTauri: () => true, invoke: async () => ({ id: native.id, now: native.now }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it.each(dropClockCases)
("fresh native observations survive $direction correction with $priorGestures old gestures (restart=$restart)", async ({ direction, priorGestures, restart }) => {
  localStorage.clear(); vi.resetModules();
  native.id = "first-process"; native.now = 100; native.perf = 10;
  let wall = 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.stubGlobal("performance", { timeOrigin: wall, now: () => native.perf });
  let clock = (await import("$lib/state/drag-clock")).dragClock;
  await clock.initialize();
  let state = (await import("$lib/state/drag.svelte")).dragState;
  const data = { path: "/source/a", name: "a", kind: "file", html5: true };
  for (let i = 0; i < priorGestures; i++) {
    state.start(data); const source = state.current;
    state.beginNative(source).failed(); native.perf += 5;
    state.endHtml5(source); state.finish(source); native.perf += 5;
  }
  wall += direction === "backward" ? -20_000 : 20_000;
  if (restart) {
    vi.resetModules(); native.id = "second-process"; native.now = 20; native.perf = 0;
    vi.stubGlobal("performance", { timeOrigin: wall, now: () => native.perf });
    clock = (await import("$lib/state/drag-clock")).dragClock; await clock.initialize();
    state = (await import("$lib/state/drag.svelte")).dragState;
  }
  native.perf += 20;
  const fresh = clock.stamp().at + 2;
  expect(state.expiredNativeObservation(fresh, null, true, native.id)).toBe(false);
  expect(state.survivingHtml5Source(fresh, 0, native.id)).toBeNull();
  // Fresh HTML5 fallback still acquires pane identity after the adjustment.
  state.start(data); const source = state.current; state.beginNative(source).failed(); native.perf += 5;
  expect(state.survivingHtml5Source(clock.stamp().at + 2, 0, native.id)?.sessionId).toBe(source?.sessionId);
  expect(state.expiredNativeObservation(clock.stamp().at + 2, source, true, native.id)).toBe(false);
  if (restart) expect(state.expiredNativeObservation(110, null, true, "first-process")).toBe(true);
  state.clear();
});
