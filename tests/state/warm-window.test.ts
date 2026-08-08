/**
 * Warm-window pooling contract (warm-window.ts + the Rust warm_pool registry,
 * simulated here by a fake invoke).
 *
 * Covers what makes Ctrl+N safe and correct:
 * - a pool miss returns false (caller falls back to a fresh window — Ctrl+N is
 *   never a no-op) and primes the pool for next time;
 * - a hit emits activate to the claimed label with geometry computed from the
 *   CLAIMING window (+30/+30 cascade / tear-off under cursor), and
 *   replenishes;
 * - a claimed label is exclusive — a second consume misses;
 * - a claimed window whose activation fails is DISCARDED (destroyed via
 *   warm_pool_discard), not leaked as an invisible "real" window;
 * - spawning respects the pool's reservation (no window when refused).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// warm-window reads window.location in spawnWarmWindow; provide a minimal stub
// for the node test environment.
(globalThis as { window?: unknown }).window = {
  location: { origin: "http://localhost", pathname: "/", search: "" },
  dispatchEvent: vi.fn(),
} as unknown as Window & typeof globalThis;

const evt = vi.hoisted(() => ({
  emitToCalls: [] as Array<{ label: string; event: string; payload: unknown }>,
  emitToFails: false,
  listener: undefined as ((event: { payload: unknown }) => Promise<void>) | undefined,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => Promise<void>) => {
    evt.listener = handler;
    return () => {};
  }),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async (label: string, event: string, payload: unknown) => {
    if (evt.emitToFails) throw new Error("window gone");
    evt.emitToCalls.push({ label, event, payload });
  }),
}));

// Capture WebviewWindow construction (no real window in unit env).
const created = vi.hoisted(() => ({
  calls: [] as Array<{ label: string; options: Record<string, unknown> }>,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  // A `function` (not arrow) so it is constructable: warm-window calls
  // `new WebviewWindow(...)`, and vitest 4 constructs mock implementations
  // with real `new` semantics.
  WebviewWindow: vi.fn(function (label: string, options: Record<string, unknown>) {
    created.calls.push({ label, options });
    return { once: vi.fn() };
  }),
}));

// The claiming window's live geometry, mirrored into the activate payload.
const currentWindow = vi.hoisted(() => ({
  calls: [] as string[],
  title: "",
  api: {
    outerPosition: async () => ({ x: 100, y: 200 }),
    outerSize: async () => ({ width: 1000, height: 700 }),
    setTitle: vi.fn(async (title: string) => {
      currentWindow.title = title;
      currentWindow.calls.push(`title:${title}`);
    }),
    show: vi.fn(async () => currentWindow.calls.push("show")),
    setPosition: vi.fn(async () => {}),
    setSize: vi.fn(async () => {}),
    setSkipTaskbar: vi.fn(async () => {}),
    unminimize: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
    setAlwaysOnTop: vi.fn(async () => {}),
    label: "explorer-warm-123",
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => currentWindow.api,
}));
vi.mock("@tauri-apps/api/dpi", () => ({
  PhysicalPosition: vi.fn(function (x: number, y: number) { return { x, y }; }),
  PhysicalSize: vi.fn(function (width: number, height: number) { return { width, height }; }),
}));

// Fake of the Rust warm_pool registry: single global pool, atomic claim.
const pool = vi.hoisted(() => ({
  ready: [] as string[],
  spawnAllowed: true,
  beginSpawnCalls: 0,
  discarded: [] as string[],
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
      case "warm_pool_discard":
        pool.discarded.push(args!.label as string);
        return undefined;
      default:
        return undefined;
    }
  }),
);
vi.mock(import("$lib/api/common"), async (orig) => {
  const actual = await orig();
  return { ...actual, invoke: invokeMock as unknown as typeof actual.invoke };
});

// window-tabs is heavy; stub the one method warm-window calls.
vi.mock("../../src/lib/state/window-tabs.svelte", () => ({
  windowTabsManager: {
    getActiveExplorer: () => ({
      currentPath: "/home/user",
      navigateTo: vi.fn(async () => {}),
      setViewMode: vi.fn(),
    }),
  },
}));

// Appearance/settings/theme pull in persisted stores; irrelevant to pool
// behavior (settings refresh runs inside the activation handler, which these
// tests never fire).
vi.mock("../../src/lib/state/window-appearance", () => ({
  explorerWindowAppearance: (title: string) => ({ title }),
}));
vi.mock("../../src/lib/state/settings.svelte", () => ({
  settingsStore: { init: vi.fn(async () => {}) },
}));
vi.mock("../../src/lib/state/theme.svelte", () => ({
  themeStore: { syncFromSettings: vi.fn() },
}));

import {
  consumeWarmWindow,
  runWarmWindow,
  spawnWarmWindow,
  WARM_ACTIVATE_EVENT,
  type WarmActivatePayload,
} from "../../src/lib/state/warm-window";

beforeEach(() => {
  window.dispatchEvent = vi.fn();
  evt.emitToCalls.length = 0;
  evt.emitToFails = false;
  evt.listener = undefined;
  created.calls.length = 0;
  currentWindow.calls.length = 0;
  currentWindow.title = "";
  pool.ready.length = 0;
  pool.discarded.length = 0;
  pool.spawnAllowed = true;
  pool.beginSpawnCalls = 0;
  invokeMock.mockClear();
});

describe("warm-window consume contract", () => {
  it("returns false on a pool miss and primes the pool for next time", async () => {
    const used = await consumeWarmWindow("/some/path", undefined, undefined);
    expect(used).toBe(false);
    expect(evt.emitToCalls).toHaveLength(0);
    expect(pool.beginSpawnCalls).toBeGreaterThan(0); // miss → prime
  });

  it("activates a claimed window at the claiming window's +30/+30 cascade", async () => {
    pool.ready.push("explorer-warm-123");

    const used = await consumeWarmWindow("/target", "tiles", undefined);

    expect(used).toBe(true);
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
    await consumeWarmWindow("/t", undefined, { x: 500, y: 300 });
    const payload = evt.emitToCalls[0].payload as WarmActivatePayload;
    expect(payload.x).toBe(380); // 500 - 120
    expect(payload.y).toBe(284); // 300 - 16
  });

  it("claims are exclusive: second consume misses and falls back", async () => {
    pool.ready.push("explorer-warm-456");
    const first = await consumeWarmWindow("/a", undefined, undefined);
    const second = await consumeWarmWindow("/b", undefined, undefined);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(evt.emitToCalls).toHaveLength(1);
  });

  it("discards the claimed window and falls back when activation fails", async () => {
    pool.ready.push("explorer-warm-9");
    evt.emitToFails = true;

    const used = await consumeWarmWindow("/x", undefined, undefined);

    expect(used).toBe(false); // caller opens a fresh window — never a no-op
    // The claimed-but-unactivatable window must be destroyed, not leaked as
    // an invisible window the registry counts as real.
    await vi.waitFor(() => expect(pool.discarded).toEqual(["explorer-warm-9"]));
  });
});

describe("warm-window spawn contract", () => {
  it("creates a hidden parked window when the pool grants a reservation", async () => {
    await spawnWarmWindow();
    expect(created.calls).toHaveLength(1);
    expect(created.calls[0].label.startsWith("explorer-warm-")).toBe(true);
    expect(created.calls[0].options.visible).toBe(false);
    expect(String(created.calls[0].options.url)).toContain("warm=1");
    expect(created.calls[0].options.title).toBe("user - Tauri Explorer");
  });

  it("creates nothing when the pool refuses (already full)", async () => {
    pool.spawnAllowed = false;
    await spawnWarmWindow();
    expect(created.calls).toHaveLength(0);
  });
});

describe("warm-window reveal contract", () => {
  it("sets the requested title before a claimed window becomes visible", async () => {
    await runWarmWindow(false);
    expect(evt.listener).toBeTypeOf("function");

    await evt.listener!({
      payload: { path: "/work/beta" } satisfies WarmActivatePayload,
    });

    expect(currentWindow.calls.slice(0, 2)).toEqual([
      "title:beta - Tauri Explorer",
      "show",
    ]);
  });
});
