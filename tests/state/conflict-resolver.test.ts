/**
 * Tests for conflict resolver prompt queueing.
 *
 * Concurrent batches (e.g. two simultaneous drops) each call prompt();
 * only one dialog can be shown at a time, so later prompts must queue
 * instead of clobbering the pending resolver (which hung the second batch).
 */
import { describe, it, expect } from "vitest";
import { conflictResolver, type ConflictInfo } from "$lib/state/conflict-resolver.svelte";

function info(fileName: string): ConflictInfo {
  return { fileName, sourcePath: `/src/${fileName}`, remaining: 0 };
}

describe("conflictResolver queueing", () => {
  it("resolves a single prompt with the user's choice", async () => {
    const p = conflictResolver.prompt(info("a.txt"));
    expect(conflictResolver.isActive).toBe(true);
    expect(conflictResolver.activeConflict?.fileName).toBe("a.txt");

    conflictResolver.resolve("overwrite", false);
    await expect(p).resolves.toEqual({ choice: "overwrite", applyToAll: false });
    expect(conflictResolver.isActive).toBe(false);
  });

  it("queues a concurrent prompt and resolves both in order", async () => {
    const p1 = conflictResolver.prompt(info("first.txt"));
    const p2 = conflictResolver.prompt(info("second.txt"));

    // The first prompt's dialog stays active; the second waits
    expect(conflictResolver.activeConflict?.fileName).toBe("first.txt");

    conflictResolver.resolve("skip", false);
    await expect(p1).resolves.toEqual({ choice: "skip", applyToAll: false });

    // The queued conflict becomes active and gets its own resolution
    expect(conflictResolver.activeConflict?.fileName).toBe("second.txt");
    conflictResolver.resolve("overwrite", true);
    await expect(p2).resolves.toEqual({ choice: "overwrite", applyToAll: true });
    expect(conflictResolver.isActive).toBe(false);
  });

  it("drains a queue of several pending prompts", async () => {
    const prompts = ["a", "b", "c"].map((n) => conflictResolver.prompt(info(`${n}.txt`)));

    conflictResolver.resolve("overwrite");
    conflictResolver.resolve("skip");
    conflictResolver.resolve("cancel");

    const results = await Promise.all(prompts);
    expect(results.map((r) => r.choice)).toEqual(["overwrite", "skip", "cancel"]);
    expect(conflictResolver.isActive).toBe(false);
  });

  it("resolve without a pending prompt is a no-op", () => {
    expect(() => conflictResolver.resolve("cancel")).not.toThrow();
    expect(conflictResolver.isActive).toBe(false);
  });

  it("returns cancel immediately for a pre-aborted prompt without entering the queue", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(conflictResolver.prompt(info("never-visible.txt"), controller.signal))
      .resolves.toEqual({ choice: "cancel", applyToAll: false });
    expect(conflictResolver.isActive).toBe(false);
  });

  it("aborts the active prompt and advances to the queued prompt", async () => {
    const controller = new AbortController();
    const active = conflictResolver.prompt(info("active.txt"), controller.signal);
    const queued = conflictResolver.prompt(info("queued.txt"));
    controller.abort();
    await expect(active).resolves.toEqual({ choice: "cancel", applyToAll: false });
    expect(conflictResolver.activeConflict?.fileName).toBe("queued.txt");
    conflictResolver.resolve("skip");
    await expect(queued).resolves.toEqual({ choice: "skip", applyToAll: false });
  });

  it("removes an aborted queued prompt without disturbing the active prompt", async () => {
    const active = conflictResolver.prompt(info("active.txt"));
    const controller = new AbortController();
    const queued = conflictResolver.prompt(info("queued.txt"), controller.signal);
    controller.abort();
    await expect(queued).resolves.toEqual({ choice: "cancel", applyToAll: false });
    expect(conflictResolver.activeConflict?.fileName).toBe("active.txt");
    conflictResolver.resolve("overwrite");
    await expect(active).resolves.toEqual({ choice: "overwrite", applyToAll: false });
    expect(conflictResolver.isActive).toBe(false);
  });
});
