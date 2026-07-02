/**
 * Warm-window pooling contract (warm-window.ts + the Rust warm_pool registry,
 * simulated here by a fake invoke).
 *
 * Covers what makes Ctrl+N safe and correct:
 * - a pool miss returns false (caller falls back to a fresh window — Ctrl+N is
 *   never a no-op) and primes the pool for next time;
 * - a hit seeds, emits activate to the claimed label with geometry computed
 *   from the CLAIMING window (+30/+30 cascade / tear-off under cursor), and
 *   replenishes;
 * - a claimed label is exclusive — a second consume misses;
 * - spawning respects the pool's reservation (no window when refused).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// warm-window reads window.location in spawnWarmWindow; provide a minimal stub
// for the node test environment.
(globalThis as { window?: unknown }).window = {
  location: { origin: "http://localhost", pathname: "/", search: "" },
} as unknown as Window & typeof globalThis;

const evt = vi.hoisted(() => ({
  emitToCalls: [] as Array<{ label: string; event: string; payload: unknown }>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async (label: string, event: string, payload: unknown) => {
    evt.emitToCalls.push({ label, event, payload });
  }),
}));

// Capture WebviewWindow construction (no real window in unit env).
const created = vi.hoisted(() => ({
  calls: [] as Array<{ label: string; options: Record<string, unknown> }>,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: vi.fn().mockImplementation((label: string, options: Record<string, unknown>) => {
    created.calls.push({ label, options });
    return { once: vi.fn() };
  }),
}));

// The claiming window's live geometry, mirrored into the activate payload.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    outerPosition: async () => ({ x: 100, y: 200 }),
    outerSize: async () => ({ width: 1000, height: 700 }),
  }),
}));

// Fake of the Rust warm_pool registry: single global pool, atomic claim.
const pool = vi.hoisted(() => ({
  ready: [] as string[],
  spawnAllowed: true,
  beginSpawnCalls: 0,
}));
const invokeMock = vi.hoisted(() =>
  vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "warm_pool_claim":
        return pool.ready.pop() ?? null;
      case "warm_pool_begin_spawn":
        pool.beginSpawnCalls++;
        return pool.spawnAllowed;
      case "warm_pool_register":
        pool.ready.push(args!.label as string);
        return undefined;
      default:
        return undefined;
    }
  }),
);
vi.mock(import("$lib/api/files"), async (orig) => {
  const actual = await orig();
  return { ...actual, invoke: invokeMock as unknown as typeof actual.invoke };
});

// window-tabs is heavy; stub the one method warm-window calls.
vi.mock("../../src/lib/state/window-tabs.svelte", () => ({
  windowTabsManager: { getActiveExplorer: () => ({ currentPath: "/home/user" }) },
}));

// Appearance pulls in settings/backdrop stores; irrelevant to pool behavior.
vi.mock("../../src/lib/state/window-appearance", () => ({
  explorerWindowAppearance: () => ({}),
}));

import {
  consumeWarmWindow,
  spawnWarmWindow,
  WARM_ACTIVATE_EVENT,
  type WarmActivatePayload,
} from "../../src/lib/state/warm-window";

beforeEach(() => {
  evt.emitToCalls.length = 0;
  created.calls.length = 0;
  pool.ready.length = 0;
  pool.spawnAllowed = true;
  pool.beginSpawnCalls = 0;
  invokeMock.mockClear();
});

describe("warm-window consume contract", () => {
  it("returns false on a pool miss and primes the pool for next time", async () => {
    const seed = vi.fn();
    const used = await consumeWarmWindow("/some/path", undefined, undefined, seed);
    expect(used).toBe(false);
    expect(seed).not.toHaveBeenCalled(); // no claim, no seed
    expect(evt.emitToCalls).toHaveLength(0);
    expect(pool.beginSpawnCalls).toBeGreaterThan(0); // miss → prime
  });

  it("activates a claimed window at the claiming window's +30/+30 cascade", async () => {
    pool.ready.push("explorer-warm-123");

    const seed = vi.fn();
    const used = await consumeWarmWindow("/target", "tiles", undefined, seed);

    expect(used).toBe(true);
    expect(seed).toHaveBeenCalledOnce();
    expect(evt.emitToCalls).toHaveLength(1);
    expect(evt.emitToCalls[0].label).toBe("explorer-warm-123");
    expect(evt.emitToCalls[0].event).toBe(WARM_ACTIVATE_EVENT);
    const payload = evt.emitToCalls[0].payload as WarmActivatePayload;
    expect(payload.path).toBe("/target");
    expect(payload.viewMode).toBe("tiles");
    // Geometry from THIS window (pos 100/200, size 1000x700) — the original
    // offset bug left the payload without x/y for plain Ctrl+N.
    expect(payload.x).toBe(130);
    expect(payload.y).toBe(230);
    expect(payload.width).toBe(1000);
    expect(payload.height).toBe(700);
    expect(pool.beginSpawnCalls).toBeGreaterThan(0); // hit → replenish
  });

  it("places a tear-off activation under the cursor", async () => {
    pool.ready.push("explorer-warm-7");
    await consumeWarmWindow("/t", undefined, { x: 500, y: 300 }, vi.fn());
    const payload = evt.emitToCalls[0].payload as WarmActivatePayload;
    expect(payload.x).toBe(380); // 500 - 120
    expect(payload.y).toBe(284); // 300 - 16
  });

  it("claims are exclusive: second consume misses and falls back", async () => {
    pool.ready.push("explorer-warm-456");
    const first = await consumeWarmWindow("/a", undefined, undefined, vi.fn());
    const second = await consumeWarmWindow("/b", undefined, undefined, vi.fn());
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(evt.emitToCalls).toHaveLength(1);
  });
});

describe("warm-window spawn contract", () => {
  it("creates a hidden parked window when the pool grants a reservation", async () => {
    await spawnWarmWindow();
    expect(created.calls).toHaveLength(1);
    expect(created.calls[0].label.startsWith("explorer-warm-")).toBe(true);
    expect(created.calls[0].options.visible).toBe(false);
    expect(String(created.calls[0].options.url)).toContain("warm=1");
  });

  it("creates nothing when the pool refuses (already full)", async () => {
    pool.spawnAllowed = false;
    await spawnWarmWindow();
    expect(created.calls).toHaveLength(0);
  });
});
