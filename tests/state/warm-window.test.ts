/**
 * Warm-window pooling handshake (warm-window.ts).
 *
 * Covers the consume contract that makes Ctrl+N safe: when no warm window has
 * signalled ready, consumeWarmWindow returns false (caller falls back to a
 * fresh window — Ctrl+N is never a no-op); when one IS ready, it seeds, emits
 * the activate event to that window, and returns true. The earlier broken
 * version marked a window usable before its listener existed, so activations
 * fired into the void — these tests pin the corrected behaviour.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// warm-window reads window.location in spawnWarmWindow; provide a minimal stub
// for the node test environment.
(globalThis as { window?: unknown }).window = {
  location: { origin: "http://localhost", pathname: "/", search: "" },
} as unknown as Window & typeof globalThis;

// Capture event wiring.
const evt = vi.hoisted(() => ({
  readyHandler: null as ((e: { payload: { label: string } }) => void) | null,
  emitToCalls: [] as Array<{ label: string; event: string; payload: unknown }>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: { label: string } }) => void) => {
    if (name === "warm-ready") evt.readyHandler = cb;
    return () => {};
  }),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async (label: string, event: string, payload: unknown) => {
    evt.emitToCalls.push({ label, event, payload });
  }),
}));

// WebviewWindow constructor is a no-op stub (no real window in unit env).
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: vi.fn().mockImplementation(() => ({ once: vi.fn() })),
}));

const invokeMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock(import("$lib/api/files"), async (orig) => {
  const actual = await orig();
  return { ...actual, invoke: invokeMock as unknown as typeof actual.invoke };
});

// window-tabs is heavy; stub the one method warm-window calls.
vi.mock("../../src/lib/state/window-tabs.svelte", () => ({
  windowTabsManager: { getActiveExplorer: () => ({ currentPath: "/home/user" }) },
}));

import {
  consumeWarmWindow,
  spawnWarmWindow,
  WARM_ACTIVATE_EVENT,
} from "../../src/lib/state/warm-window";

beforeEach(() => {
  evt.emitToCalls.length = 0;
  invokeMock.mockClear();
});

describe("warm-window consume contract", () => {
  it("returns false when no warm window is ready (caller falls back)", async () => {
    const seed = vi.fn();
    const used = await consumeWarmWindow("/some/path", undefined, undefined, seed);
    expect(used).toBe(false);
    expect(seed).not.toHaveBeenCalled(); // no claim, no seed
    expect(evt.emitToCalls).toHaveLength(0);
  });

  it("activates a ready window: seeds, emits activate to its label, returns true", async () => {
    // Spawn registers the warm-ready listener; simulate the warm window
    // signalling ready with its label.
    spawnWarmWindow();
    expect(evt.readyHandler).toBeTypeOf("function");
    evt.readyHandler!({ payload: { label: "explorer-warm-123" } });

    const seed = vi.fn();
    const used = await consumeWarmWindow("/target", "tiles", { x: 500, y: 300 }, seed);

    expect(used).toBe(true);
    expect(seed).toHaveBeenCalledOnce();
    expect(evt.emitToCalls).toHaveLength(1);
    expect(evt.emitToCalls[0].label).toBe("explorer-warm-123");
    expect(evt.emitToCalls[0].event).toBe(WARM_ACTIVATE_EVENT);
    const payload = evt.emitToCalls[0].payload as { path: string; viewMode?: string };
    expect(payload.path).toBe("/target");
    expect(payload.viewMode).toBe("tiles");
  });

  it("consumes a ready window only once (second consume falls back)", async () => {
    spawnWarmWindow();
    evt.readyHandler!({ payload: { label: "explorer-warm-456" } });

    const first = await consumeWarmWindow("/a", undefined, undefined, vi.fn());
    const second = await consumeWarmWindow("/b", undefined, undefined, vi.fn());
    expect(first).toBe(true);
    expect(second).toBe(false); // label was claimed; nothing ready now
  });
});
