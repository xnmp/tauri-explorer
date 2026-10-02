/**
 * Production failure logging for tear-off tab seeds (#884): a window that
 * cannot adopt, or cannot acknowledge, its sender's tab writes a failure line
 * to the native log in every build, while successful phases stay silent
 * outside hook builds.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { log, emitTo } = vi.hoisted(() => ({ log: vi.fn(), emitTo: vi.fn(async () => {}) }));
vi.mock("$lib/api/frontend-log", () => ({ logFrontendDiagnostic: log }));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emitTo,
}));

import { createWindowTabsManager, tabSeedKey } from "$lib/state/window-tabs.svelte";

const SEED_KEY = tabSeedKey("main");
const handoff = { sourceWindow: "explorer-source", requestId: "request-1" };
let manager: ReturnType<typeof createWindowTabsManager>;

function writeSeed(seed: unknown): void {
  localStorage.setItem(SEED_KEY, JSON.stringify(seed));
}

function initChild(): string | null {
  manager = createWindowTabsManager();
  const tab = manager.init("/home/fallback", true);
  return tab ? manager.getTabPath(tab.id) ?? null : null;
}

const failures = () => log.mock.calls.filter(([event]) => event === "window tab seed failed");

beforeEach(() => {
  localStorage.clear();
  log.mockClear();
  emitTo.mockReset();
  emitTo.mockResolvedValue(undefined);
});
afterEach(async () => {
  await manager?.dispose();
});

it("logs an adopted seed that carries no hand-off, since its sender waits in vain", () => {
  writeSeed({ ts: Date.now(), snapshot: { path: "/home/torn-off" } });

  expect(initChild()).toBe("/home/torn-off");
  expect(failures()).toEqual([["window tab seed failed", expect.objectContaining({
    label: "main", phase: "acknowledgement-skipped", requestId: null,
    seedPresent: true, fresh: true, snapshotValid: true, handoffValid: false, error: null,
  })]]);
  expect(localStorage.getItem(SEED_KEY)).toBeNull();
});

it("logs a stale seed as rejected, with the sender's request and the seed's age", () => {
  writeSeed({ ts: Date.now() - 60_000, snapshot: { path: "/home/torn-off" }, handoff });

  expect(initChild()).toBe("/home/fallback");
  const [[, context]] = failures();
  expect(context).toMatchObject({
    phase: "rejected", requestId: "request-1",
    seedPresent: true, fresh: false, snapshotValid: false, handoffValid: true,
  });
  expect(context.seedAgeMs).toBeGreaterThanOrEqual(60_000);
});

it("logs a malformed seed as rejected", () => {
  writeSeed({ ts: Date.now(), snapshot: { path: "" } });

  expect(initChild()).toBe("/home/fallback");
  expect(failures()).toEqual([["window tab seed failed", expect.objectContaining({
    phase: "rejected", fresh: true, snapshotValid: false, handoffValid: false,
  })]]);
});

it("logs a failed acknowledgement of an adopted seed", async () => {
  emitTo.mockRejectedValueOnce(new Error("source window closed"));
  writeSeed({ ts: Date.now(), snapshot: { path: "/home/torn-off" }, handoff });

  expect(initChild()).toBe("/home/torn-off");
  await vi.waitFor(() => expect(failures()).toEqual([["window tab seed failed", expect.objectContaining({
    phase: "acknowledgement-error", requestId: "request-1", error: "Error: source window closed",
  })]]));
});

it("logs nothing when the window has no seed or adopts and acknowledges one without hooks", async () => {
  expect(initChild()).toBe("/home/fallback");
  await manager.dispose();

  writeSeed({ ts: Date.now(), snapshot: { path: "/home/torn-off" }, handoff });
  expect(initChild()).toBe("/home/torn-off");
  await vi.waitFor(() => expect(emitTo).toHaveBeenCalledWith(
    "explorer-source", expect.any(String), expect.objectContaining({ requestId: "request-1" }),
  ));
  await Promise.resolve();
  // Success phases (read/adopted/acknowledged) are hook-build progress only.
  expect(log).not.toHaveBeenCalled();
});
