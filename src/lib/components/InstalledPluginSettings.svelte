<script lang="ts">
  import { matchesSettingsQuery } from "$lib/domain/settings-search";
  let { query = "" }: { query?: string } = $props();
  import { onMount } from "svelte";
  import {isTauri} from "$lib/api/common";
  import { listen } from "@tauri-apps/api/event";
  import { pluginRegistry } from "$lib/plugins/registry.svelte";
  import { installPackage, uninstallPackage, setPackageEnabled, installedPackages, packageFailure, refreshInstalledPackages, packageError, type InstalledPackage } from "$lib/plugins/installed";
  let packages=$state<readonly InstalledPackage[]>([]);
  let busy=$state(false);
  let error=$state("");
  async function refresh(){await refreshInstalledPackages(pluginRegistry);packages=[...installedPackages()];}
  async function perform(action:()=>Promise<void>){
    if(busy)return;busy=true;error="";
    try{await action();await refresh();}catch(cause){error=packageError(cause);}finally{busy=false;}
  }
  onMount(()=>{
    let active=true;let unlisten:(()=>void)|undefined;
    void refresh().catch((cause)=>{if(active)error=packageError(cause);});
    if(isTauri())void listen("plugins:changed",()=>{if(active)void refresh().catch((cause)=>{error=packageError(cause);});}).then((dispose)=>{if(active)unlisten=dispose;else dispose();});
    return ()=>{active=false;unlisten?.();};
  });
</script>
<div class="packages">
  <button class="install" disabled={busy} onclick={()=>perform(()=>installPackage(pluginRegistry))}>Install plugin…</button>
  {#if error}<p role="alert">{error}</p>{/if}
  {#each packages.filter(entry => matchesSettingsQuery(query, entry.manifest.name, entry.manifest.description, entry.manifest.version)) as entry (entry.manifest.id)}
    <div class="package">
      <div><strong>{entry.manifest.name}</strong> <span>{entry.manifest.version}</span>
        {#if packageFailure(entry.manifest.id)}<p role="alert">{packageFailure(entry.manifest.id)}</p>{/if}
      </div>
      <label><input type="checkbox" checked={entry.enabled} disabled={busy} aria-label={`Enable ${entry.manifest.name}`} onchange={(event)=>perform(()=>setPackageEnabled(entry.manifest.id,event.currentTarget.checked,pluginRegistry))}/> Enabled</label>
      <button disabled={busy} onclick={()=>perform(()=>uninstallPackage(entry.manifest.id,pluginRegistry))}>Remove</button>
    </div>
  {/each}
</div>
<style>
  .packages{display:grid;gap:12px;margin-bottom:16px}.install{justify-self:start}.package{display:flex;flex-wrap:wrap;align-items:center;gap:16px}.package>div{flex:1 1 160px;min-width:0}.package span{font-size:12px;opacity:.65}.package label{display:flex;align-items:center;gap:6px;font-size:12px}button{padding:6px 10px;color:var(--text-color);background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:4px}button:disabled{opacity:.5}p{font-size:12px;color:var(--error-color,#c44);margin:6px 0}
</style>
