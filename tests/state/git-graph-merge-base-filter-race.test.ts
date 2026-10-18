import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGitGraphBranches } from '$lib/state/git-graph-branches.svelte';
import { createDebouncedReload } from '$lib/state/git-graph-debounced-reload';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Mirrors the view's wiring: every reload retires an in-flight lookup. */
function wiring(mergeBase: () => Promise<string | null>) {
  const session = createGitGraphBranches('/repo', {
    refs: async () => ({ local_branches: [], remote_branches: [], tags: [], head: null, head_branch: null, detached: false }),
    branchAuthors: async () => [], mergeBase,
  });
  const reloads = vi.fn();
  const filterReload = createDebouncedReload(() => { session.cancelMergeBase(); reloads(); }, 200);
  const reveal = vi.fn(async () => true);
  const jump = () => session.jumpToMergeBase({ name: 'a', remote: false }, { name: 'b', remote: false }, reveal, filterReload.defer,
    (revealed) => { if (revealed) filterReload.cancel(); else filterReload.releaseDeferred(); });
  return { session, filterReload, reloads, reveal, jump };
}

it('a path-filter reload pending when the jump starts cannot retire the lookup (#1281)', async () => {
  let resolve!: (oid: string) => void;
  const { session, filterReload, reloads, reveal, jump } = wiring(() => new Promise((r) => { resolve = r; }));
  filterReload.schedule();
  const pending = jump();
  await vi.advanceTimersByTimeAsync(250); // debounce window elapses mid-lookup
  resolve('fork');
  await pending;
  expect(reloads).not.toHaveBeenCalled();
  expect(reveal).toHaveBeenCalledWith('fork', expect.any(Function));
  expect(session.mergeBaseResult).toEqual({ first: 'a', second: 'b', oid: 'fork' });
  session.dispose();
});

it('a deferred filter reload still runs when there is no common ancestor', async () => {
  let resolve!: (oid: string | null) => void;
  const { session, filterReload, reloads, reveal, jump } = wiring(() => new Promise((r) => { resolve = r; }));
  filterReload.schedule();
  const pending = jump();
  await vi.advanceTimersByTimeAsync(250);
  expect(reloads).not.toHaveBeenCalled();
  resolve(null);
  await pending;
  expect(reveal).not.toHaveBeenCalled();
  expect(reloads).toHaveBeenCalledOnce();
  session.dispose();
});

it('a deferred filter reload runs when the reveal fails', async () => {
  const { session, filterReload, reloads, reveal, jump } = wiring(async () => 'fork');
  reveal.mockResolvedValue(false);
  filterReload.schedule();
  await jump();
  expect(reloads).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(500);
  expect(reloads).toHaveBeenCalledOnce();
  session.dispose();
});

it('a successful reveal runs no filtered reload', async () => {
  const { session, filterReload, reloads, jump } = wiring(async () => 'fork');
  filterReload.schedule();
  await jump();
  await vi.advanceTimersByTimeAsync(500);
  expect(reloads).not.toHaveBeenCalled();
  session.dispose();
});

it('typing during the lookup yields exactly one reload, the newest', async () => {
  let resolve!: (oid: string | null) => void;
  const { session, filterReload, reloads, jump } = wiring(() => new Promise((r) => { resolve = r; }));
  filterReload.schedule();
  const pending = jump();
  session.cancelMergeBase(); // onFilePathFilterInput
  filterReload.schedule();
  resolve(null);
  await pending;
  await vi.advanceTimersByTimeAsync(500);
  expect(reloads).toHaveBeenCalledOnce();
  session.dispose();
});

it('typing after the jump starts still retires the lookup', async () => {
  let resolve!: (oid: string) => void;
  const { session, filterReload, reloads, reveal, jump } = wiring(() => new Promise((r) => { resolve = r; }));
  const pending = jump();
  session.cancelMergeBase(); // what onFilePathFilterInput does
  filterReload.schedule();
  await vi.advanceTimersByTimeAsync(250);
  resolve('fork');
  await pending;
  expect(reloads).toHaveBeenCalledOnce();
  expect(reveal).not.toHaveBeenCalled();
  session.dispose();
});

it('debounce coalesces rapid schedules and cancel drops the pending run', async () => {
  const fn = vi.fn();
  const d = createDebouncedReload(fn, 200);
  d.schedule(); await vi.advanceTimersByTimeAsync(150); d.schedule();
  await vi.advanceTimersByTimeAsync(150);
  expect(fn).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60);
  expect(fn).toHaveBeenCalledOnce();
  d.schedule(); d.cancel();
  await vi.advanceTimersByTimeAsync(500);
  expect(fn).toHaveBeenCalledOnce();
});
