import { describe, expect, it, vi } from "vitest";
import { createGitGraphCoverage } from "$lib/state/git-graph-coverage";
import { createPathWatch } from "$lib/state/directory-watch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(listen = vi.fn(async () => true)) {
  const watch = vi.fn(async (path: string) => path);
  const unwatch = vi.fn(async (_lease: string) => {});
  const coverage = createGitGraphCoverage({ listen, createWatch: () => createPathWatch({ watch, unwatch }) });
  return { coverage, listen, watch, unwatch };
}

describe("graph cache observation ownership", () => {
  it("does not retain recursive polling watches for hidden network-share snapshots", async () => {
    const { coverage, watch, listen } = fixture();
    for (const path of ["//server/share/repo", "\\\\wsl.localhost\\Ubuntu\\repo"]) {
      const lease = coverage.retain(path);
      await expect(lease.ready).resolves.toBe(false);
      lease.release();
    }
    expect(watch).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("acknowledges event delivery before watching, and native acquisition before readiness", async () => {
    const delivery = deferred<boolean>();
    const acquisition = deferred<string>();
    const { coverage, watch, unwatch } = fixture(vi.fn(() => delivery.promise));
    watch.mockReturnValue(acquisition.promise);
    const lease = coverage.retain("/repo");
    const ready = vi.fn();
    void lease.ready.then(ready);
    await Promise.resolve();
    expect(watch).not.toHaveBeenCalled();
    delivery.resolve(true);
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith("/repo"));
    expect(ready).not.toHaveBeenCalled();
    acquisition.resolve("/repo");
    await expect(lease.ready).resolves.toBe(true);
    lease.release();
    await vi.waitFor(() => expect(unwatch).toHaveBeenCalledWith("/repo"));
  });

  it("shares normalized repositories but preserves the original IPC path and releases only the last owner", async () => {
    const { coverage, watch, unwatch } = fixture();
    const first = coverage.retain("/repo/");
    const second = coverage.retain("/repo");
    await Promise.all([first.ready, second.ready]);
    expect(watch).toHaveBeenCalledExactlyOnceWith("/repo/");
    first.release(); first.release();
    await Promise.resolve();
    expect(unwatch).not.toHaveBeenCalled();
    second.release();
    await vi.waitFor(() => expect(unwatch).toHaveBeenCalledExactlyOnceWith("/repo/"));
  });

  it("does not acquire an abandoned repository while listener attachment is pending", async () => {
    const delivery = deferred<boolean>();
    const { coverage, watch } = fixture(vi.fn(() => delivery.promise));
    const lease = coverage.retain("/repo");
    await Promise.resolve();
    lease.release();
    delivery.resolve(true);
    await expect(lease.ready).resolves.toBe(false);
    expect(watch).not.toHaveBeenCalled();
  });

  it("drains an abandoned acquisition without releasing its replacement", async () => {
    const acquisition = deferred<string>();
    const { coverage, watch, unwatch } = fixture();
    watch.mockReturnValueOnce(acquisition.promise);
    const abandoned = coverage.retain("/repo");
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    abandoned.release();
    const replacement = coverage.retain("/repo");
    await expect(replacement.ready).resolves.toBe(true);
    acquisition.resolve("/repo");
    await expect(abandoned.ready).resolves.toBe(false);
    await vi.waitFor(() => expect(unwatch).toHaveBeenCalledOnce());
    replacement.release();
    await vi.waitFor(() => expect(unwatch).toHaveBeenCalledTimes(2));
  });

  it("refuses uncovered retention and lets a later owner retry failed delivery", async () => {
    const { coverage, watch, listen } = fixture();
    listen.mockResolvedValueOnce(false);
    const failed = coverage.retain("/repo");
    await expect(failed.ready).resolves.toBe(false);
    expect(watch).not.toHaveBeenCalled();
    failed.release();
    const retry = coverage.retain("/repo");
    await expect(retry.ready).resolves.toBe(true);
    expect(watch).toHaveBeenCalledOnce();
    retry.release();
  });
});
