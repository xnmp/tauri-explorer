import { describe, expect, it, vi } from "vitest";
import { createPaneSessions } from "$lib/state/pane-sessions";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(releasePane = vi.fn<(_: string) => void | Promise<void>>()) {
  const reportCleanupError = vi.fn();
  const sessions = createPaneSessions<{ destroy(): Promise<void> }>({ releasePane, reportCleanupError });
  return { sessions, releasePane, reportCleanupError };
}

describe("pane resource lifetime", () => {
  it("opens reserved directories only once on activation and releases unvisited pane metadata", async () => {
    const { sessions, releasePane } = setup();
    const resource = { destroy: vi.fn(async () => {}) };
    const factory = vi.fn(() => resource);
    const start = vi.fn(async () => {});
    sessions.reserve("active", factory, start);
    sessions.reserve("unvisited", factory, start);
    expect(factory).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(sessions.get("active")).toBeUndefined();
    expect(() => sessions.create("unvisited", factory, start)).toThrow("already exists");
    expect(sessions.activate("active")).toBe(resource);
    expect(sessions.activate("active")).toBe(resource);
    expect(factory).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    sessions.remove("unvisited");
    expect(releasePane).toHaveBeenCalledWith("unvisited");
    expect(sessions.activate("unvisited")).toBeUndefined();
    await sessions.dispose();
    expect(resource.destroy).toHaveBeenCalledOnce();
    expect(sessions.activate("active")).toBeUndefined();
    expect(factory).toHaveBeenCalledOnce();
  });

  it("drains cleanup for reserved panes without creating their resources", async () => {
    const cleanup = deferred();
    const { sessions } = setup(vi.fn(() => cleanup.promise));
    const factory = vi.fn(() => ({ destroy: vi.fn(async () => {}) }));
    sessions.reserve("pane", factory, async () => {});
    let settled = false;
    const disposal = sessions.dispose().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    cleanup.resolve();
    await disposal;
    expect(settled).toBe(true);
  });

  it("detaches before replacement, and old cleanup cannot remove the new resource", async () => {
    const { sessions, releasePane } = setup();
    const oldCleanup = deferred();
    const previous = { destroy: vi.fn(() => oldCleanup.promise) };
    const replacement = { destroy: vi.fn(async () => {}) };
    sessions.create("pane", () => previous, async () => {});
    sessions.clear();
    expect(sessions.get("pane")).toBeUndefined();
    expect(releasePane).toHaveBeenCalledWith("pane");
    sessions.create("pane", () => replacement, async () => {});
    oldCleanup.resolve();
    await oldCleanup.promise;
    expect(sessions.get("pane")).toBe(replacement);
    await sessions.dispose();
    expect(previous.destroy).toHaveBeenCalledOnce();
    expect(replacement.destroy).toHaveBeenCalledOnce();
  });

  it("rejects duplicate IDs and creation after disposal before allocating anything", async () => {
    const { sessions } = setup();
    const factory = vi.fn(() => ({ destroy: vi.fn(async () => {}) }));
    const start = vi.fn(async () => {});
    const original = sessions.create("pane", factory, start);
    expect(() => sessions.create("pane", factory, start)).toThrow("already exists");
    expect(sessions.get("pane")).toBe(original);
    const disposal = sessions.dispose();
    expect(() => sessions.create("new", factory, start)).toThrow("after disposal");
    expect(factory).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(sessions.dispose()).toBe(disposal);
    await disposal;
  });

  it("drains sibling cleanup and initial loads before rejecting, including synchronous cleanup errors", async () => {
    const error = new Error("release failed");
    const releasePane = vi.fn(() => { throw error; });
    const { sessions } = setup(releasePane);
    const cleanup = deferred();
    const load = deferred();
    const resource = { destroy: vi.fn(() => cleanup.promise) };
    sessions.create("pane", () => resource, () => load.promise);
    const disposal = sessions.dispose();
    const outcome = expect(disposal).rejects.toBe(error);
    let settled = false;
    void disposal.catch(() => { settled = true; });
    expect(resource.destroy).toHaveBeenCalledOnce();
    cleanup.resolve();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(settled).toBe(false);
    load.resolve();
    await outcome;
  });

  it("settles failed navigation without turning it into a cleanup failure", async () => {
    const { sessions, reportCleanupError } = setup();
    const resource = { destroy: vi.fn(async () => {}) };
    sessions.create("pane", () => resource, async () => { throw new Error("unavailable directory"); });
    sessions.remove("missing");
    sessions.remove("pane");
    sessions.remove("pane");
    await expect(sessions.dispose()).resolves.toBeUndefined();
    expect(resource.destroy).toHaveBeenCalledOnce();
    expect(reportCleanupError).not.toHaveBeenCalled();
  });
});
