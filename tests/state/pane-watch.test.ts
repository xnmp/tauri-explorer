/** Public behavior of per-pane directory-observation ownership. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectoryWatchLease } from "$lib/api/files";
import type { DirectoryChange, DirectorySubscription } from "$lib/state/directory-events";
import { createPaneWatch } from "$lib/state/pane-watch";

type RefreshOptions = { silent: boolean };
type ScheduledRefresh = {
  callback: (options: RefreshOptions) => void | false | Promise<void>;
  path: string;
  silent: boolean;
  key: unknown;
  observedAt?: number;
};

const lease = (id: string, path: string): DirectoryWatchLease => ({ id, path });

function createHarness(
  release: (lease: DirectoryWatchLease) => Promise<void> = vi.fn(async () => {}),
) {
  let notify!: (change: DirectoryChange) => void;
  const subscription: DirectorySubscription = {
    ready: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  const subscribe = vi.fn((callback: (change: DirectoryChange) => void) => {
    notify = callback;
    return subscription;
  });
  const prepare = vi.fn(async (_path: string, _subscription: DirectorySubscription) => {});
  const refresh = vi.fn(async (_options: RefreshOptions) => {});
  const scheduled: ScheduledRefresh[] = [];
  const schedule = vi.fn((
    callback: ScheduledRefresh["callback"],
    path: string,
    silent = true,
    key: unknown = callback,
    observedAt?: number,
  ) => {
    scheduled.push({ callback, path, silent, key, observedAt });
  });
  const watch = createPaneWatch({ refresh, subscribe, release, prepare, schedule });
  return {
    watch,
    notify: (change: DirectoryChange) => notify(change),
    subscription,
    subscribe,
    prepare,
    refresh,
    release: vi.mocked(release),
    scheduled,
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

async function commitPath(
  harness: ReturnType<typeof createHarness>,
  path: string,
  ownedLease: DirectoryWatchLease | null,
) {
  const ticket = harness.watch.begin(path);
  await ticket.ready;
  expect(ticket.current()).toBe(true);
  expect(ticket.accept(ownedLease)).toBe(true);
  expect(ticket.commit()).toBe(true);
  expect(ticket.current()).toBe(false);
  return ticket;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createPaneWatch", () => {
  it("stages an observed path and retains the old lease until UI commit", async () => {
    const harness = createHarness();
    const leaseA = lease("a", "/a");
    const leaseB = lease("b", "/b");

    await commitPath(harness, "/a", leaseA);
    const next = harness.watch.begin("/b");
    await next.ready;

    expect(harness.prepare).toHaveBeenLastCalledWith("/b", harness.subscription);
    expect(next.accept(leaseB)).toBe(true);
    await drainMicrotasks();
    expect(harness.release).not.toHaveBeenCalled();

    expect(next.commit()).toBe(true);
    await drainMicrotasks();
    expect(harness.release).toHaveBeenCalledOnce();
    expect(harness.release).toHaveBeenCalledWith(leaseA);

    next.close();
    await harness.watch.destroy();
    expect(harness.release).toHaveBeenCalledTimes(2);
    expect(harness.release).toHaveBeenLastCalledWith(leaseB);
  });

  it("keeps the committed lease across failed and cancelled navigation", async () => {
    const harness = createHarness();
    const leaseA = lease("a", "/a");
    const cancelledLease = lease("cancelled", "/cancelled");
    await commitPath(harness, "/a", leaseA);

    harness.prepare.mockRejectedValueOnce(new Error("observation unavailable"));
    const failed = harness.watch.begin("/failed");
    await expect(failed.ready).rejects.toThrow("observation unavailable");
    failed.close();

    const cancelled = harness.watch.begin("/cancelled");
    await cancelled.ready;
    expect(cancelled.accept(cancelledLease)).toBe(true);
    cancelled.close();
    await drainMicrotasks();
    expect(harness.release).toHaveBeenCalledOnce();
    expect(harness.release).toHaveBeenCalledWith(cancelledLease);

    harness.notify({ path: "/a", observedAt: 20 });
    expect(harness.scheduled).toHaveLength(1);
    await harness.scheduled[0].callback({ silent: true });
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(harness.release).not.toHaveBeenCalledWith(leaseA);

    await harness.watch.destroy();
    expect(harness.release).toHaveBeenCalledWith(leaseA);
  });

  it("replays pending-target dirtiness only after that target commits", async () => {
    const harness = createHarness();
    await commitPath(harness, "/a", lease("a", "/a"));
    const target = harness.watch.begin("/b");
    await target.ready;

    const observedAt = Date.now() + 1;
    harness.notify({ path: "/b", observedAt });
    expect(harness.scheduled).toHaveLength(0);
    expect(harness.refresh).not.toHaveBeenCalled();

    expect(target.accept(lease("b", "/b"))).toBe(true);
    expect(target.commit()).toBe(true);
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]).toMatchObject({ path: "/b", silent: true, observedAt });
    expect(harness.refresh).not.toHaveBeenCalled();

    await harness.scheduled[0].callback({ silent: true });
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(harness.refresh).toHaveBeenCalledWith({ silent: true });
    await harness.watch.destroy();
  });

  it("replays old-path dirtiness when target navigation rolls back", async () => {
    const harness = createHarness();
    await commitPath(harness, "/a", lease("a", "/a"));
    const target = harness.watch.begin("/b");
    await target.ready;

    harness.notify({ path: "/a", observedAt: 30 });
    expect(harness.scheduled).toHaveLength(0);
    target.close();

    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]).toMatchObject({ path: "/a", observedAt: 30 });
    await harness.scheduled[0].callback({ silent: true });
    expect(harness.refresh).toHaveBeenCalledOnce();
    await harness.watch.destroy();
  });

  it("does not let a callback scheduled before navigation refresh during navigation", async () => {
    const harness = createHarness();
    await commitPath(harness, "/a", lease("a", "/a"));
    expect(harness.watch.allowRefresh("/a")).toBe(true);
    harness.notify({ path: "/a", observedAt: 40 });
    expect(harness.scheduled).toHaveLength(1);

    const target = harness.watch.begin("/b");
    await target.ready;
    expect(harness.watch.allowRefresh("/a")).toBe(false);
    await harness.scheduled[0].callback({ silent: true });
    expect(harness.refresh).not.toHaveBeenCalled();

    target.close();
    expect(harness.scheduled).toHaveLength(2);
    expect(harness.scheduled[1].path).toBe("/a");
    await harness.scheduled[1].callback({ silent: true });
    expect(harness.refresh).toHaveBeenCalledOnce();
    await harness.watch.destroy();
  });

  it("lets the caller discard stale A to B to A lease replies by identity", async () => {
    const harness = createHarness();
    const firstA = harness.watch.begin("/a");
    const targetB = harness.watch.begin("/b");
    const currentA = harness.watch.begin("/a");
    await Promise.all([firstA.ready, targetB.ready, currentA.ready]);

    const staleA = lease("stale-a", "/a");
    const staleB = lease("stale-b", "/b");
    const acceptedA = lease("current-a", "/a");
    expect(firstA.accept(staleA)).toBe(false);
    firstA.discard(staleA);
    expect(targetB.accept(staleB)).toBe(false);
    targetB.discard(staleB);
    expect(currentA.accept(acceptedA)).toBe(true);
    expect(currentA.commit()).toBe(true);
    firstA.close();
    targetB.close();
    await drainMicrotasks();

    expect(harness.release).toHaveBeenCalledTimes(2);
    expect(harness.release).toHaveBeenCalledWith(staleA);
    expect(harness.release).toHaveBeenCalledWith(staleB);
    expect(harness.release).not.toHaveBeenCalledWith(acceptedA);

    await harness.watch.destroy();
    expect(harness.release).toHaveBeenCalledWith(acceptedA);
  });

  it("seals destroy, awaits open tickets, and retries failed releases", async () => {
    const attempts = new Map<string, number>();
    const release = vi.fn(async (ownedLease: DirectoryWatchLease) => {
      const attempt = (attempts.get(ownedLease.id) ?? 0) + 1;
      attempts.set(ownedLease.id, attempt);
      if (attempt === 1) throw new Error(`release ${ownedLease.id} failed`);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness(release);
    const committedLease = lease("committed", "/a");
    const stagedLease = lease("staged", "/b");
    await commitPath(harness, "/a", committedLease);
    const pending = harness.watch.begin("/b");
    await pending.ready;
    expect(pending.accept(stagedLease)).toBe(true);

    let settled = false;
    const destroying = harness.watch.destroy().then(() => { settled = true; });
    await drainMicrotasks();
    expect(settled).toBe(false);
    expect(harness.subscription.stop).toHaveBeenCalledOnce();
    expect(pending.current()).toBe(false);
    expect(harness.release).toHaveBeenCalledTimes(2);

    pending.close();
    await destroying;
    expect(attempts).toEqual(new Map([
      ["committed", 2],
      ["staged", 2],
    ]));

    const afterDestroy = harness.watch.begin("/late");
    await expect(afterDestroy.ready).rejects.toThrow("Pane observation is destroyed");
    expect(afterDestroy.current()).toBe(false);
    afterDestroy.close();
    await harness.watch.destroy();
    expect(harness.prepare).toHaveBeenCalledTimes(2);
  });


});
