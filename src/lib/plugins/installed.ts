import type {Plugin,PluginContext} from "./api";
import {invoke,extractError,isTauri} from "$lib/api/common";
import {convertFileSrc} from "@tauri-apps/api/core";
const SVELTE_ABI="5.56.3";

export interface InstalledPackage {
  digest:string;
  enabled:boolean;
  manifest:{id:string;name:string;description:string;version:string;sdkVersion:number;svelteVersion:string;frontend:string;styles:string;contributions:string[]};
}
export interface PackageRegistry {registerInstalled(plugins:Plugin[]):Promise<void>;removeInstalled(ids:readonly string[]):Promise<void>}
let current:InstalledPackage[]=[];
const loaded=new Map<string,InstalledPackage>();
const failures=new Map<string,string>();
const styles=new Map<string,HTMLLinkElement>();
let transition=Promise.resolve();

function serial(work:()=>Promise<void>):Promise<void>{const next=transition.catch(()=>{}).then(work);transition=next;return next;}
async function load(entry:InstalledPackage,registry:PackageRegistry):Promise<void> {
  const {manifest}=entry;
  if(manifest.sdkVersion!==1||manifest.svelteVersion!==SVELTE_ABI)throw new Error(`${manifest.name} requires a different plugin host`);
  (await import("./runtime-sdk")).exposePluginSDK();
  const base=`/${manifest.id}/${entry.digest}/`;
  const url=convertFileSrc(base+manifest.frontend,"plugin");
  const module=await import(/* @vite-ignore */ url) as {plugins?:Plugin[]};
  if(!Array.isArray(module.plugins)||new Set(module.plugins.map((plugin)=>plugin.id)).size!==module.plugins.length||module.plugins.length!==manifest.contributions.length||module.plugins.some((plugin)=>!manifest.contributions.includes(plugin.id)||typeof plugin.activate!=="function"))throw new Error("Plugin contributions differ from the installed manifest");
  const link=document.createElement("link");link.rel="stylesheet";link.href=convertFileSrc(base+manifest.styles,"plugin");
  await new Promise<void>((resolve,reject)=>{link.onload=()=>resolve();link.onerror=()=>reject(new Error(`Could not load ${manifest.name} styles`));document.head.append(link);});
  styles.set(manifest.id,link);
  const backend={invoke:<T>(method:string,params?:Record<string,unknown>)=>invoke<T>("plugin_backend_invoke",{packageId:manifest.id,method,params:params??{}})};
  try {
    await registry.registerInstalled(module.plugins.map((plugin)=>({...plugin,activate:(ctx:PluginContext)=>plugin.activate({...ctx,backend})})));
    loaded.set(manifest.id,entry);failures.delete(manifest.id);
  } catch(error) { link.remove();styles.delete(manifest.id);throw error; }
}

export function installedPackages():readonly InstalledPackage[]{return current;}
export async function refreshInstalledPackages(registry:PackageRegistry):Promise<void>{
  return serial(async()=>{
    const next=await invoke<InstalledPackage[]>("list_installed_plugins");
    for(const old of loaded.values())if(!next.some((entry)=>entry.manifest.id===old.manifest.id&&entry.enabled&&entry.digest===old.digest)){
      await registry.removeInstalled(old.manifest.contributions);styles.get(old.manifest.id)?.remove();styles.delete(old.manifest.id);loaded.delete(old.manifest.id);
    }
    for(const entry of next)if(entry.enabled&&!loaded.has(entry.manifest.id)){
      try { await load(entry,registry); } catch(error) { failures.set(entry.manifest.id,extractError(error)); }
    }
    current=next;
  });
}

export async function installPackage(registry:PackageRegistry):Promise<void>{
  const path=await invoke<string|null>("pick_file",{options:{mode:"open",title:"Install plugin package"}});
  if(!path)return;
  await invoke("install_plugin",{path});
  await refreshInstalledPackages(registry);
}
export async function uninstallPackage(id:string,registry:PackageRegistry):Promise<void>{
  await invoke("uninstall_plugin",{id});
  await refreshInstalledPackages(registry);
}
export const packageError=extractError;

export function packageFailure(id:string):string|undefined{return failures.get(id);}
export async function setPackageEnabled(id:string,enabled:boolean,registry:PackageRegistry):Promise<void>{
  await invoke("set_plugin_package_enabled",{id,enabled});await refreshInstalledPackages(registry);
}
let watching=false;
export async function watchInstalledPackages(registry:PackageRegistry):Promise<void>{
  if(!isTauri()||watching)return;watching=true;
  try { const {listen}=await import("@tauri-apps/api/event");await listen("plugins:changed",()=>{void refreshInstalledPackages(registry).catch((error)=>console.error("Could not refresh installed plugins",error));}); }
  catch(error){watching=false;throw error;}
}
