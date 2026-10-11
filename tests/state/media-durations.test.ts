import { describe, expect, it, vi } from "vitest";
import { MediaDurationResolver } from "$lib/state/media-durations.svelte";
import type { FileEntry } from "$lib/domain/file";

function file(path: string, size = 1, modified = "2026-01-01T00:00:00Z"): FileEntry {
  return { name: path.split("/").pop()!, path, kind: "file", size, modified };
}
function dir(path: string): FileEntry {
  return { name: path.split("/").pop()!, path, kind: "directory", size: 0, modified: "" };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("MediaDurationResolver (#995)", () => {
  it("probes only video files and exposes their durations", async () => {
    const probe = vi.fn(async (paths: string[]) => paths.map((path) => (path.endsWith(".mp4") ? 754 : 3725)));
    const resolver = new MediaDurationResolver({ probe });
    const entries = [file("/v/a.mp4"), file("/v/b.MKV"), file("/v/song.mp3"), file("/v/notes.txt"), dir("/v/clips.mp4")];

    for (const entry of entries) resolver.request(entry);
    expect(resolver.duration(entries[0])).toBeUndefined();
    await flush();

    expect(probe.mock.calls.flatMap(([paths]) => paths).sort()).toEqual(["/v/a.mp4", "/v/b.MKV"]);
    expect(resolver.duration(entries[0])).toBe(754);
    expect(resolver.duration(entries[1])).toBe(3725);
    expect(resolver.duration(entries[2])).toBeUndefined();
    expect(resolver.duration(entries[4])).toBeUndefined();
  });

  it("batches rendered rows requested in the same tick", async () => {
    const probe = vi.fn(async (paths: string[]) => paths.map(() => 1));
    const resolver = new MediaDurationResolver({ probe, batchSize: 8, maxConcurrent: 1 });
    for (let i = 0; i < 5; i++) resolver.request(file(`/v/${i}.mp4`));
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0]).toHaveLength(5);
  });

  it("does not re-probe an unchanged file but re-probes a changed one", async () => {
    const probe = vi.fn(async (paths: string[]) => paths.map(() => 10));
    const resolver = new MediaDurationResolver({ probe });
    resolver.request(file("/v/a.mp4"));
    await flush();
    resolver.request(file("/v/a.mp4"));
    resolver.request(file("/v/a.mp4"));
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);

    const changed = file("/v/a.mp4", 2, "2026-01-02T00:00:00Z");
    expect(resolver.duration(changed)).toBeUndefined();
    probe.mockImplementationOnce(async (paths: string[]) => paths.map(() => 20));
    resolver.request(changed);
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(resolver.duration(changed)).toBe(20);
  });

  it("resolves unreadable durations to null, including probe failures", async () => {
    const probe = vi.fn(async (paths: string[]) => {
      if (paths.includes("/v/fail.mp4")) throw new Error("ipc failed");
      return paths.map(() => null);
    });
    const resolver = new MediaDurationResolver({ probe, batchSize: 1 });
    resolver.request(file("/v/broken.mp4"));
    resolver.request(file("/v/fail.mp4"));
    await flush();
    expect(resolver.duration(file("/v/broken.mp4"))).toBeNull();
    expect(resolver.duration(file("/v/fail.mp4"))).toBeNull();
    // Failures are cached for the unchanged revision too.
    resolver.request(file("/v/fail.mp4"));
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("bounds concurrent probe calls", async () => {
    let active = 0;
    let peak = 0;
    const probe = vi.fn(async (paths: string[]) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return paths.map(() => 1);
    });
    const resolver = new MediaDurationResolver({ probe, batchSize: 1, maxConcurrent: 2 });
    for (let i = 0; i < 6; i++) resolver.request(file(`/v/${i}.mp4`));
    await flush();
    await flush();
    expect(probe).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });
});
