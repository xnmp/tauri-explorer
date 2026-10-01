/**
 * Tests for the serialized latest-wins config file writer (persisted.ts).
 *
 * Rapid successive saves of the same file must not produce concurrent
 * (interleaving) writes; intermediate contents are skipped (latest wins).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface PendingWrite {
  filename: string;
  data: string;
  resolve: () => void;
}

const pendingWrites: PendingWrite[] = [];

vi.mock("$lib/api/config", () => ({
  writeConfigFile: vi.fn(
    (filename: string, data: string) =>
      new Promise((resolve) => {
        pendingWrites.push({
          filename,
          data,
          resolve: () => resolve({ ok: true, data: undefined }),
        });
      }),
  ),
}));

import { writeConfigQueued } from "$lib/state/persisted";

beforeEach(() => {
  pendingWrites.length = 0;
});

async function flushMicrotasks() {
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("writeConfigQueued", () => {
  it("writes immediately when nothing is in flight", async () => {
    const done = writeConfigQueued("a.json", "v1");
    await flushMicrotasks();

    expect(pendingWrites).toHaveLength(1);
    expect(pendingWrites[0]).toMatchObject({ filename: "a.json", data: "v1" });

    pendingWrites[0].resolve();
    await done;
  });

  it("serializes writes to the same file, skipping intermediate content (latest wins)", async () => {
    const first = writeConfigQueued("a.json", "v1");
    const second = writeConfigQueued("a.json", "v2");
    const third = writeConfigQueued("a.json", "v3");
    await flushMicrotasks();

    // Only the first write is on disk-in-progress; v2/v3 are queued
    expect(pendingWrites).toHaveLength(1);
    expect(pendingWrites[0].data).toBe("v1");

    pendingWrites[0].resolve();
    await flushMicrotasks();

    // v2 was superseded by v3 before the first write finished
    expect(pendingWrites).toHaveLength(2);
    expect(pendingWrites[1].data).toBe("v3");

    pendingWrites[1].resolve();
    await Promise.all([first, second, third]);
    expect(pendingWrites).toHaveLength(2);
  });

  it("writes to different files independently", async () => {
    writeConfigQueued("a.json", "a1");
    writeConfigQueued("b.json", "b1");
    await flushMicrotasks();

    expect(pendingWrites.map((w) => w.filename)).toEqual(["a.json", "b.json"]);
    pendingWrites.forEach((w) => w.resolve());
  });

  it("accepts new writes after the chain settles", async () => {
    const first = writeConfigQueued("a.json", "v1");
    await flushMicrotasks();
    pendingWrites[0].resolve();
    await first;

    const second = writeConfigQueued("a.json", "v2");
    await flushMicrotasks();
    expect(pendingWrites).toHaveLength(2);
    expect(pendingWrites[1].data).toBe("v2");
    pendingWrites[1].resolve();
    await second;
  });
});
