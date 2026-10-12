import { expect, it, vi } from 'vitest';
import { createGitGraphQuerySession } from '$lib/state/git-graph-query.svelte';
import type { CommitInfo } from '$lib/api/git-log';

const commit = (oid: string): CommitInfo => ({ oid, short_oid: oid, parents: [], author_name: 'A', author_email: 'a@b.com', author_time: 1, summary: oid });
function fixture() {
  const seed = { commits: [commit('tip')], refs: {}, hasMore: true, headOid: 'tip', headBranch: 'main', detached: false, workingChanges: 0, nextCursor: 'tip' };
  const gitLog = vi.fn(async () => ({ commits: [commit('fork')], refs: {}, has_more: false, next_cursor: null, head_branch: 'main', detached: false }));
  const session = createGitGraphQuerySession({ repoPath: '/repo', summaryConsumerId: 'test', readQuery: () => ({ branches: null, localOnly: false, hideRemoteOnly: false, filePath: '' }), readBranches: () => [], refreshBranches: async () => {} }, {
    gitLog, getSnapshot: () => seed,
    beginSnapshotWrite: () => ({ ready: Promise.resolve(true), publish: () => true, dispose: () => {} }),
    fetchPage0Snapshot: async () => seed,
  });
  return { session, gitLog };
}
it('finds an ancestor beyond page zero in the actual graph history', async () => {
  const { session, gitLog } = fixture();
  expect(await session.findCommit('fork')).toMatchObject({ oid: 'fork' });
  expect(session.commits.map(c => c.oid)).toEqual(['tip', 'fork']);
  expect(gitLog).toHaveBeenCalledOnce();
  session.dispose();
});
it('does not return a stale ancestor after disposal while paging', async () => {
  const { session, gitLog } = fixture();
  let finish!: (value: Awaited<ReturnType<typeof gitLog>>) => void;
  gitLog.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = session.findCommit('fork');
  session.dispose();
  finish({ commits: [commit('fork')], refs: {}, has_more: false, next_cursor: null, head_branch: 'main', detached: false });
  expect(await pending).toBeNull();
});
it('stops and reports a failed history page instead of looping', async () => {
  const { session, gitLog } = fixture();
  gitLog.mockRejectedValue(new Error('history unavailable'));
  await expect(session.findCommit('fork')).rejects.toThrow('history unavailable');
  expect(gitLog).toHaveBeenCalledOnce();
  session.dispose();
});

import { createGitGraphBranches } from '$lib/state/git-graph-branches.svelte';
function lookupFixture(resolve = vi.fn(async (): Promise<string | null> => 'fork')) {
  const session = createGitGraphBranches('/repo', {
    refs: async () => ({ local_branches: [], remote_branches: [], tags: [], head: null, head_branch: null, detached: false }),
    branchAuthors: async () => [], mergeBase: resolve,
  });
  const reveal = vi.fn(async () => true);
  const first = { name: 'left', remote: false };
  const second = { name: 'origin/right', remote: true };
  return { session, resolve, reveal, first, second };
}
it('reports unrelated histories without moving graph selection', async () => {
  const { session, reveal, first, second } = lookupFixture(vi.fn(async () => null));
  await session.jumpToMergeBase(first, second, reveal);
  expect(reveal).not.toHaveBeenCalled();
  expect(session.mergeBaseError).toBe('These branches have no common ancestor');
  expect(session.mergeBaseBusy).toBe(false);
  session.dispose();
});
it('cannot reveal a superseded branch-pair lookup', async () => {
  let finish!: (oid: string) => void;
  const { session, reveal, first, second } = lookupFixture(vi.fn(() => new Promise(resolve => { finish = resolve; })));
  const pending = session.jumpToMergeBase(first, second, reveal);
  expect(session.mergeBaseBusy).toBe(true);
  session.cancelMergeBase();
  finish('fork');
  await pending;
  expect(reveal).not.toHaveBeenCalled();
  expect(session.mergeBaseBusy).toBe(false);
  session.dispose();
});
it('reports lookup errors without invoking selection', async () => {
  const { session, reveal, first, second } = lookupFixture(vi.fn(async () => { throw new Error('branch disappeared'); }));
  await session.jumpToMergeBase(first, second, reveal);
  expect(reveal).not.toHaveBeenCalled();
  expect(session.mergeBaseError).toBe('branch disappeared');
  session.dispose();
});

import { gitMergeBase } from '$lib/api/git-log';
import * as common from '$lib/api/common';
it('sends exact branch refs over IPC, including a remote/local name collision', async () => {
  const invoke = vi.spyOn(common, 'invoke').mockResolvedValue('fork');
  try {
    expect(await gitMergeBase('/repo', { name: 'origin/right', remote: true }, { name: 'origin/right', remote: false })).toBe('fork');
    expect(invoke).toHaveBeenCalledWith('git_merge_base', {
      repoPath: '/repo', firstRef: 'refs/remotes/origin/right', secondRef: 'refs/heads/origin/right',
    });
  } finally { invoke.mockRestore(); }
});
it('joins a page already being loaded by scrolling before revealing the ancestor', async () => {
  const { session, gitLog } = fixture();
  let finish!: (value: Awaited<ReturnType<typeof gitLog>>) => void;
  gitLog.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const scrolling = session.loadMore();
  const lookup = session.findCommit('fork');
  finish({ commits: [commit('fork')], refs: {}, has_more: false, next_cursor: null, head_branch: 'main', detached: false });
  await scrolling;
  expect(await lookup).toMatchObject({ oid: 'fork' });
  expect(gitLog).toHaveBeenCalledOnce();
  session.dispose();
});
it('does not retain a previous successful result when a later lookup has no ancestor', async () => {
  const { session, resolve, reveal, first, second } = lookupFixture();
  await session.jumpToMergeBase(first, second, reveal);
  expect(session.mergeBaseResult).toMatchObject({ oid: 'fork' });
  resolve.mockResolvedValueOnce(null);
  await session.jumpToMergeBase(first, second, reveal);
  expect(session.mergeBaseResult).toBeNull();
  expect(session.mergeBaseError).toBe('These branches have no common ancestor');
  session.dispose();
});
