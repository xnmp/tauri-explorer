/** Run: bun scripts/bench-directory-reconciliation.ts. Unchanged-listing microbenchmark only; not startup or concurrent-merge timing. */
import { reconcileDirectoryEntries, reconcileDirectorySelection } from "../src/lib/domain/directory-reconciliation";
import type { FileEntry } from "../src/lib/domain/file";
const fingerprint = (entries: readonly FileEntry[]) => entries.map(e => `${e.path}\0${e.size}\0${e.modified}`).join("\n");
const summarize = (samples: number[]) => {
  samples.sort((a,b) => a-b);
  return { p50: samples[Math.floor(samples.length*.5)], p95: samples[Math.floor(samples.length*.95)] };
};
const results=[];
for (const count of [10000, 100000]) {
  const before=Array.from({length:count},(_,i)=>({name:`file-${i}.txt`,path:`/work/file-${i}.txt`,kind:"file" as const,size:i,modified:"2026-01-01T00:00:00Z"}));
  const incoming=before.map(e=>({...e}));
  const selection={selectedPaths:new Set([before[0].path]),cursorPath:before[0].path,anchorPath:before[0].path};
  const runOld=()=>fingerprint(before)===fingerprint(incoming);
  const runNew=()=>{const listing=reconcileDirectoryEntries(before,before,incoming);const selected=reconcileDirectorySelection(listing.entries,selection);return listing.entries===before && selected.selectedPaths===selection.selectedPaths && selected.cursorPath===selection.cursorPath && !selected.needsRefresh;};
  for(let i=0;i<10;i++){runOld();runNew();}
  const oldSamples=[],newSamples=[];
  for(let i=0;i<40;i++){
    let start=performance.now();if(!runOld())throw Error("old result mismatch");oldSamples.push(performance.now()-start);
    start=performance.now();if(!runNew())throw Error("new result mismatch");newSamples.push(performance.now()-start);
  }
  results.push({count,scenario:"unchanged complete listing, distinct equivalent entry objects, first entry selected",samples:40,oldFingerprintMs:summarize(oldSamples),newReconciliationMs:summarize(newSamples)});
}
console.log(JSON.stringify({runtime:Bun.version,measurement:"Bun microbenchmark, not WebView frame/startup timing",results},null,2));
