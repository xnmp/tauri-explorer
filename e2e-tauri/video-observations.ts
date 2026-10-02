/** Read-only observations of the real native decoder, pixels and transport. */
import { browser, $ } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { nativeProcessIdentity, type NativeFileIdentity } from "./native-resources";
import { domText } from "./specs/helpers";

export interface VideoStats {
  read_bytes: number; read_calls: number; max_chunk_bytes: number;
  active_connections: number; active_leases: number; open_workers: number; active_streams: number;
}
export async function videoStats(): Promise<VideoStats> {
  await browser.waitUntil(() => browser.execute(() => document.documentElement.dataset.e2eVideoReady === "true"));
  const token = randomUUID();
  await browser.execute(token => window.dispatchEvent(new CustomEvent("e2e-video-operation", { detail: { token, op: "stats" } })), token);
  let response: { token?: string; result?: VideoStats; error?: string } = {};
  await browser.waitUntil(async () => {
    response = await browser.execute(() => JSON.parse(document.documentElement.dataset.e2eVideoResult ?? "{}"));
    return response.token === token;
  }, { timeoutMsg: "one native video stats request did not settle" });
  if (response.error) throw new Error(response.error);
  if (!response.result) throw new Error("native video stats reply omitted its result");
  return response.result;
}
export async function videoCommand(label: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed();
  await input.setValue(label.startsWith("Dock Preview Pane ") ? `preview ${label.split(" ").at(-1)!.toLowerCase()}` : label);
  await browser.waitUntil(async () => (await domText(".command-palette-dialog")).includes(label));
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}
export function videoState() {
  return browser.execute(() => {
    const video = document.querySelector<HTMLVideoElement>(".video-preview video");
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return { paused: video.paused, muted: video.muted, volume: video.volume,
      currentTime: video.currentTime, duration: video.duration, readyState: video.readyState,
      seeking: video.seeking, src: video.currentSrc || video.getAttribute("src"),
      width: video.videoWidth, height: video.videoHeight, errorCode: video.error?.code ?? null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight } };
  });
}
/** Native range keyboard semantics; never assigns media or input properties. */
export async function rangeKeys(selector: string, increments: number): Promise<void> {
  await $(selector).click();
  await browser.performActions([{ type: "key", id: "native-video-range", actions: [
    { type: "keyDown", value: "\uE011" }, { type: "keyUp", value: "\uE011" },
    ...Array.from({ length: increments }, () => [{ type: "keyDown" as const, value: "\uE014" }, { type: "keyUp" as const, value: "\uE014" }]).flat(),
  ] }]);
  await browser.releaseActions();
}
export async function observeRetirement(): Promise<string> {
  const token = randomUUID();
  await browser.execute(token => {
    const video = document.querySelector<HTMLVideoElement>(".video-preview video")!;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      if (video.getAttribute("src") !== null) return;
      root.dataset.e2eNativeVideoRetired = JSON.stringify({ token, paused: video.paused,
        src: video.getAttribute("src"), readyState: video.readyState });
      observer.disconnect();
    });
    observer.observe(video, { attributes: true, attributeFilter: ["src"] });
  }, token);
  return token;
}
export async function retiredObservation(token: string) {
  let result: {token?: string;paused?: boolean;src?: string|null;readyState?:number} = {};
  await browser.waitUntil(async () => {
    result = await browser.execute(() => JSON.parse(document.documentElement.dataset.e2eNativeVideoRetired ?? "{}"));
    return result.token === token;
  }, { timeoutMsg: "departed video did not remove its actual src" });
  return result;
}
export interface VideoResourceSample {
  at: number; appRssBytes: number; webKitRssBytes: number; totalRssBytes: number;
  processes: {pid:number;executable:string;startTime:string;rssBytes:number}[];
}
export function videoResources(): VideoResourceSample {
  const processes: VideoResourceSample["processes"] = [];
  for (const value of fs.readdirSync("/proc").filter(value => /^\d+$/.test(value))) {
    const pid = Number(value);
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid?.()) continue;
      if (!/^(tauri-explorer|WebKitWebProces|WebKitNetworkPr)$/.test(fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim())) continue;
      const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(v => v.includes("=")).map(v => { const i=v.indexOf("="); return [v.slice(0,i),v.slice(i+1)]; }));
      if (env.XDG_CONFIG_HOME !== process.env.XDG_CONFIG_HOME) continue;
      const identity = nativeProcessIdentity(pid);
      if (!/(tauri-explorer|WebKitWebProcess|WebKitNetworkProcess)$/.test(identity.executable)) continue;
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const rssBytes = Number(status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1] ?? 0)*1024;
      processes.push({ ...identity, rssBytes });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (!processes.some(value => value.executable.endsWith("/tauri-explorer"))) throw new Error("owned native video application is missing");
  const appRssBytes=processes.filter(p=>p.executable.endsWith("/tauri-explorer")).reduce((sum,p)=>sum+p.rssBytes,0);
  const webKitRssBytes=processes.filter(p=>!p.executable.endsWith("/tauri-explorer")).reduce((sum,p)=>sum+p.rssBytes,0);
  return { at:Date.now(), processes, appRssBytes, webKitRssBytes,totalRssBytes:appRssBytes+webKitRssBytes };
}
export function sampleVideoResources() {
  const samples = [videoResources()]; const errors: string[] = [];
  const timer=setInterval(()=>{try{samples.push(videoResources());}catch(error){errors.push(String(error));}},200);
  return {stop:()=>{clearInterval(timer);samples.push(videoResources());return {samples,errors};}};
}
export function mediaFileHandles(identity: NativeFileIdentity): {pid:number;fd:string}[] {
  return videoResources().processes.flatMap(process => fs.readdirSync(`/proc/${process.pid}/fd`).flatMap(fd=>{
    try {const st=fs.statSync(`/proc/${process.pid}/fd/${fd}`,{bigint:true});return st.dev===identity.device&&st.ino===identity.inode?[{pid:process.pid,fd}]:[];}
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;return [];}
  }));
}
/** Decode the actual native screenshot, avoiding tainted cross-origin canvases. */
export async function screenshotPixels(file: string, sampleSize=9) {
  const state=await videoState();if(!state)throw new Error("no real video to inspect");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(!process.env.TAURI_NATIVE_VIDEO_PROFILE||!process.env.DISPLAY||process.env.GDK_BACKEND!=="x11"||process.env.WAYLAND_DISPLAY)throw new Error("Native video capture requires the private X11 profile");
  // Keep the WebView snapshot too: platform video layers can differ from it.
  await browser.saveScreenshot(file.replace(/\.png$/,"-webdriver.png"));
  const appPids=videoResources().processes.filter(p=>p.executable.endsWith("/tauri-explorer")).map(p=>p.pid);
  const clients=execFileSync("xprop",["-root","_NET_CLIENT_LIST"],{encoding:"utf8"}).match(/0x[0-9a-f]+/g)??[];
  const windows=clients.flatMap(id=>{
    const properties=execFileSync("xprop",["-id",id,"_NET_WM_PID"],{encoding:"utf8"});
    const pid=Number(properties.match(/= (\d+)/)?.[1]);
    const geometry=execFileSync("xwininfo",["-id",id],{encoding:"utf8"});
    return appPids.includes(pid)&&geometry.includes("Map State: IsViewable")?[{id,width:Number(geometry.match(/Width: (\d+)/)?.[1]),height:Number(geometry.match(/Height: (\d+)/)?.[1])}]:[];
  });
  if(windows.length!==1)throw new Error(`Native video window identity is ambiguous: ${windows.length}`);
  const window=windows[0];
  execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-f","x11grab","-draw_mouse","0","-window_id",String(Number(window.id)),"-video_size",`${window.width}x${window.height}`,"-i",process.env.DISPLAY,"-frames:v","1","-y",file]);
  const probe=JSON.parse(execFileSync("ffprobe",["-v","error","-show_entries","stream=width,height","-of","json",file],{encoding:"utf8"}));
  const {width,height}=probe.streams[0];
  const x=Math.round((state.rect.x+state.rect.width/2)*width/state.viewport.width-sampleSize/2);
  const y=Math.round((state.rect.y+state.rect.height/2)*height/state.viewport.height-sampleSize/2);
  if(x<0||y<0||x+sampleSize>width||y+sampleSize>height)throw new Error("video sample lies outside actual screenshot");
  const pixels=execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-i",file,"-vf",`crop=${sampleSize}:${sampleSize}:${x}:${y}`,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"]);
  const channels=[0,1,2].map(channel=>Array.from({length:sampleSize*sampleSize},(_,i)=>pixels[i*3+channel]));
  return {rgb:channels.map(values=>values.reduce((sum,n)=>sum+n,0)/values.length),
    deviation:channels.map(values=>{const mean=values.reduce((sum,n)=>sum+n,0)/values.length;return Math.sqrt(values.reduce((sum,n)=>sum+(n-mean)**2,0)/values.length);}),state,sample:{x,y,size:sampleSize},image:{width,height}};
}
