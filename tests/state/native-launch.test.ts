import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), open: vi.fn() }));
vi.mock("$lib/api/common", () => ({ invoke: h.invoke, isTauri: () => true }));
vi.mock("$lib/domain/platform", () => ({ isMac: false, isWindows: false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("$lib/state/window-launch", () => ({ openNewWindow: h.open }));
import { startNativeLaunchReceiver } from "$lib/state/native-launch";
beforeEach(() => { h.invoke.mockReset(); h.listen.mockReset(); h.open.mockReset(); h.open.mockResolvedValue(null); });

it("opens launches that preceded the listener and serializes later notifications", async () => {
  let notify!: () => void;
  const unlisten = vi.fn();
  h.listen.mockImplementation(async (_event, callback) => { notify = callback; return unlisten; });
  h.invoke.mockResolvedValueOnce(["/early"]).mockResolvedValueOnce(["/later"]).mockResolvedValue([]);
  const stop = startNativeLaunchReceiver();
  await vi.waitFor(() => expect(h.open).toHaveBeenCalledExactlyOnceWith("/early"));
  notify(); notify();
  await vi.waitFor(() => expect(h.open.mock.calls).toEqual([["/early"], ["/later"]]));
  stop(); expect(unlisten).toHaveBeenCalledTimes(1);
});

it("retires a late subscription without consuming launch requests after session disposal", async () => {
  let complete!: (stop: () => void) => void;
  h.listen.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const stop = startNativeLaunchReceiver(); stop();
  const unlisten = vi.fn(); complete(unlisten);
  await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  expect(h.invoke).not.toHaveBeenCalled(); expect(h.open).not.toHaveBeenCalled();
});
