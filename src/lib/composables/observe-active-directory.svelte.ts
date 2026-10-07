import { untrack } from "svelte";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";

/** Lifecycle-owned observation without polling or cloning directory listings. */
export function observeActiveDirectory(listener: (path:string|null)=>void): ()=>void {
  return $effect.root(()=>{
    $effect(()=>{
      const path = windowTabsManager.getActiveExplorer()?.currentPath ?? null;
      untrack(()=>listener(path));
    });
  });
}
