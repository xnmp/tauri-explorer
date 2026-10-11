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
