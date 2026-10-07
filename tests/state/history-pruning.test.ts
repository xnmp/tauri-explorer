import { it, expect, vi } from 'vitest';
const checks = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('$lib/api/files', () => ({ checkPathsExist: checks.fn }));
import { recentFilesStore } from '$lib/state/recent-files.svelte';
import { frecencyStore } from '$lib/state/frecency.svelte';
it('an older absence check cannot erase same-timestamp recent re-use', async () => {
 vi.spyOn(Date, 'now').mockReturnValue(1000);
 let release!: (value: boolean[]) => void;
 checks.fn.mockImplementationOnce(() => new Promise(resolve => release=resolve));
 recentFilesStore.clear(); recentFilesStore.add('/reused','reused','file');
 const prune=recentFilesStore.pruneNonExistent();
 recentFilesStore.add('/reused','reused','file');
 release([false]); await prune;
 expect(recentFilesStore.list.map(entry=>entry.path)).toContain('/reused');
});
it('an older absence check cannot erase repeated same-timestamp folder re-use', async () => {
 vi.spyOn(Date, 'now').mockReturnValue(1000);
 let release!: (value: boolean[]) => void;
 checks.fn.mockImplementationOnce(() => new Promise(resolve => release=resolve));
 frecencyStore.clear(); for(let i=0;i<10;i++) frecencyStore.recordAccess('/reused');
 const prune=frecencyStore.pruneNonExistent();
 frecencyStore.recordAccess('/reused');
 release([false]); await prune;
 expect(frecencyStore.entries.map(entry=>entry.path)).toContain('/reused');
});
