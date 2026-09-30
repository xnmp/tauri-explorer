import { expect, it, vi } from "vitest";
import { createForegroundGate } from "$lib/state/page-foreground";

// A parked warm window defers foreground-only feeds until activation (#931).

it("starts immediately in a foreground page", async () => {
  const gate = createForegroundGate(true);
  const start = vi.fn();
  gate.whenForeground(start);
  await gate.enterForeground();
  expect(start).toHaveBeenCalledTimes(1);
});

it("defers starts while parked and runs each once on entering the foreground", async () => {
  const gate = createForegroundGate(false);
  const first = vi.fn(); const second = vi.fn();
  gate.whenForeground(first);
  gate.whenForeground(second);
  await Promise.resolve();
  expect(first).not.toHaveBeenCalled();
  expect(gate.isForeground).toBe(false);

  await gate.enterForeground();
  await gate.enterForeground();
  expect(gate.isForeground).toBe(true);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

it("entering the foreground waits for every deferred start to settle", async () => {
  const gate = createForegroundGate(false);
  let finish!: () => void;
  const loaded = vi.fn();
  gate.whenForeground(async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    loaded();
  });
  let entered = false;
  const entering = gate.enterForeground().then(() => { entered = true; });
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(entered).toBe(false);
  finish();
  await entering;
  expect(loaded).toHaveBeenCalled();
});

it("a failing start neither blocks nor rejects activation", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const gate = createForegroundGate(false);
  const healthy = vi.fn();
  gate.whenForeground(() => { throw new Error("feed unavailable"); });
  gate.whenForeground(healthy);
  await expect(gate.enterForeground()).resolves.toBeUndefined();
  expect(healthy).toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

it("a cancelled deferred start never runs", async () => {
  const gate = createForegroundGate(false);
  const start = vi.fn();
  const cancel = gate.whenForeground(start);
  cancel();
  await gate.enterForeground();
  expect(start).not.toHaveBeenCalled();
});
