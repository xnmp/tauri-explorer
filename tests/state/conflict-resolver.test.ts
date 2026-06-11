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
});
