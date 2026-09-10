import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPathWatch } from "$lib/state/directory-watch";

interface Lease { id: string; canonicalPath: string }

function fixture() {
  let nextId = 0;
  const watch = vi.fn(async (path: string): Promise<Lease> => ({
    id: String(++nextId),
    canonicalPath: `/canonical${path}`,
  }));
  const unwatch = vi.fn(async (_lease: Lease): Promise<void> => {});
  return { owner: createPathWatch({ watch, unwatch }), watch, unwatch };
}

beforeEach(() => vi.restoreAllMocks());

describe("createPathWatch", () => {
  it("releases the exact acquired lease before acquiring the replacement", async () => {
    const { owner, watch, unwatch } = fixture();
    await owner.update("/a");
    const firstLease = await watch.mock.results[0].value;

    await owner.update("/b");

    expect(unwatch).toHaveBeenCalledExactlyOnceWith(firstLease);
    expect(unwatch.mock.invocationCallOrder[0]).toBeLessThan(watch.mock.invocationCallOrder[1]);
  });

  it("retains a lease after failed release and retries it before replacement acquisition", async () => {
    const { owner, watch, unwatch } = fixture();
    await owner.update("/a");
    const firstLease = await watch.mock.results[0].value;
    unwatch.mockRejectedValueOnce(new Error("release unavailable"));

    await expect(owner.update("/b")).rejects.toThrow("release unavailable");
    expect(watch).toHaveBeenCalledTimes(1);

    await owner.update("/b");
    expect(unwatch).toHaveBeenNthCalledWith(1, firstLease);
    expect(unwatch).toHaveBeenNthCalledWith(2, firstLease);
    expect(watch).toHaveBeenNthCalledWith(2, "/b");
  });

  it("drains a pending acquisition through destroy and releases its returned identity", async () => {
    let resolveAcquire!: (lease: Lease) => void;
    const lease = { id: "late", canonicalPath: "/canonical/a" };
    const watch = vi.fn(() => new Promise<Lease>((resolve) => { resolveAcquire = resolve; }));
    const unwatch = vi.fn(async (_lease: Lease) => {});
    const owner = createPathWatch({ watch, unwatch });

    const acquiring = owner.update("/a");
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith("/a"));
    const destroying = owner.destroy();
    resolveAcquire(lease);

    await Promise.all([acquiring, destroying]);
    expect(unwatch).toHaveBeenCalledExactlyOnceWith(lease);
    await owner.update("/late");
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("seals updates after destroy while allowing a failed release to be retried", async () => {
    const { owner, watch, unwatch } = fixture();
    await owner.update("/a");
    const lease = await watch.mock.results[0].value;
    unwatch.mockRejectedValueOnce(new Error("release unavailable"));

    const firstDestroy = owner.destroy();
    expect(owner.destroy()).toBe(firstDestroy);
    await expect(firstDestroy).rejects.toThrow("release unavailable");

    await owner.update("/ignored");
    expect(watch).toHaveBeenCalledTimes(1);

    await owner.destroy();
    expect(unwatch).toHaveBeenNthCalledWith(1, lease);
    expect(unwatch).toHaveBeenNthCalledWith(2, lease);
  });

  it("skips obsolete queued acquisitions", async () => {
    const { owner, watch } = fixture();
    void owner.update("/a");
    void owner.update("/b");
    await owner.update("/c");
    expect(watch).toHaveBeenCalledExactlyOnceWith("/c");
  });
});
