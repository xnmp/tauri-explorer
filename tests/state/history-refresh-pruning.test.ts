import {it,expect,vi,beforeEach,afterEach} from 'vitest';
const hooks=vi.hoisted(()=>({recent:null as any,frequent:null as any,check:vi.fn(),enqueue:vi.fn()}));
vi.mock('$lib/api/files',()=>({checkPathsExist:hooks.check}));
vi.mock('$lib/state/shared-history',()=>({enqueueHistory:hooks.enqueue,registerRecentHistory:(store:any)=>hooks.recent=store,registerFrecencyHistory:(store:any)=>hooks.frequent=store}));
import {recentFilesStore} from '$lib/state/recent-files.svelte';
import {frecencyStore} from '$lib/state/frecency.svelte';
import {sanitizeRecentHistory,sanitizeFrecencyHistory} from '$lib/domain/history';
beforeEach(()=>{vi.clearAllMocks();recentFilesStore.clear();frecencyStore.clear();vi.spyOn(Date,'now').mockReturnValue(1000);});
afterEach(()=>vi.restoreAllMocks());
function deferred(){let release!:(value:boolean[])=>void;hooks.check.mockImplementationOnce(()=>new Promise(resolve=>release=resolve));return (value:boolean[])=>release(value);}
for(const collection of ['recent','frecency'] as const){
 const set=(entries:any[])=>collection==='recent'?hooks.recent.set(sanitizeRecentHistory(entries)):hooks.frequent.set(sanitizeFrecencyHistory(entries));
 const record=(path:string,revision:number)=>collection==='recent'?{name:path.slice(1),path,kind:'file',timestamp:1000,revision}:{path,accesses:[1000],revision};
 const paths=()=>collection==='recent'?recentFilesStore.list.map(e=>e.path):frecencyStore.entries.map(e=>e.path);
 const prune=()=>collection==='recent'?recentFilesStore.pruneNonExistent():frecencyStore.pruneNonExistent();
 it(`${collection}: unrelated canonical addition does not exempt an unchanged missing record`,async()=>{
  set([record('/gone',7)]);const release=deferred();const pending=prune();set([record('/gone',7),record('/new',8)]);release([false]);await pending;expect(paths()).toEqual(['/new']);
 });
 it(`${collection}: a canonical revision advance protects re-use from an older absence check`,async()=>{
  set([record('/reused',7)]);const release=deferred();const pending=prune();set([record('/reused',8)]);release([false]);await pending;expect(paths()).toEqual(['/reused']);
  const sent=hooks.enqueue.mock.calls.at(-1)![0];expect(sent).toMatchObject({type:'prune',entries:[{key:'/reused',revision:7}]});
 });
 it(`${collection}: removed external records cannot be resurrected by an older check`,async()=>{
  set([record('/gone',7)]);const release=deferred();const pending=prune();set([record('/new',8)]);release([true]);await pending;expect(paths()).toEqual(['/new']);
 });
}
it('an unrelated access still prunes an unchanged dismissed canonical folder',async()=>{
 hooks.frequent.set(sanitizeFrecencyHistory([{path:'/gone',accesses:[1,2,3,4],revision:7}]));
 frecencyStore.dismissRecent('/gone');
 const release=deferred();const pending=frecencyStore.pruneNonExistent();
 frecencyStore.recordAccess('/new');release([false]);await pending;
 expect(frecencyStore.entries.map(entry=>entry.path)).toEqual(['/new']);
});
it('prunes every missing occurrence in malformed duplicate persisted recent history',async()=>{
 const record={name:'gone',path:'/gone',kind:'file',timestamp:1000};
 hooks.recent.set(sanitizeRecentHistory([record,{...record}]));
 const release=deferred();const pending=recentFilesStore.pruneNonExistent();release([false,false]);await pending;
 expect(recentFilesStore.list.map(entry=>entry.path)).toEqual([]);
});
