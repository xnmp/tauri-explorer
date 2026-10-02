/** Actual Linux decoder/HTTP outcomes; opt in with an owned profile and encoded fixtures. */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { createNativeFixtureDirectory } from "../native-qualification";
import { nativeFileIdentity, type NativeFileIdentity } from "../native-resources";
import { entryPathSelector, navigateTo } from "./helpers";
import { videoStats, videoCommand, videoState, rangeKeys, screenshotPixels,
  observeRetirement, retiredObservation, sampleVideoResources, mediaFileHandles } from "../video-observations";

const enabled=process.platform==="linux"&&!!process.env.TAURI_NATIVE_VIDEO_PROFILE;
const output=process.env.TAURI_NATIVE_VIDEO_ARTIFACT_DIR??"e2e-tauri/logs/video-preview";
const proof="screenshots/feat/native-video-preview";
let directory:string;let colors:string;let revision:string;let large:string;let text:string;
const report=(name:string,value:unknown)=>{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+"\n");};
async function hashFile(file:string):Promise<string>{const hash=createHash("sha256");for await(const chunk of fs.createReadStream(file,{highWaterMark:64*1024}))hash.update(chunk);return hash.digest("hex");}
async function ready(){await $('[aria-label="Play video"]').waitForEnabled({timeout:20_000});const state=await videoState();expect(state?.duration).toBeGreaterThan(0);expect(state?.src).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/media\/[a-f0-9]{48}$/);return state!;}
async function select(file:string){await $(entryPathSelector(file)).click();if(!await $(".preview-pane").isDisplayed())await videoCommand("Toggle Preview Pane");return ready();}
async function playAndPause(){await $('[aria-label="Play video"]').click();await browser.waitUntil(async()=>{const state=await videoState();return !!state&&!state.paused&&state.currentTime>0.15&&state.readyState>=2;});await $('[aria-label="Pause video"]').click();expect((await videoState())?.paused).toBe(true);}
async function seekFour(){await rangeKeys('[aria-label="Seek video"]',40);await browser.waitUntil(async()=>{const state=await videoState();return !!state&&!state.seeking&&Math.abs(state.currentTime-4)<0.15&&state.readyState>=2;});}
async function pixel(name:string,color:"red"|"blue"){let result:Awaited<ReturnType<typeof screenshotPixels>>|undefined;await browser.waitUntil(async()=>{result=await screenshotPixels(path.join(proof,`${name}.png`));const [r,,b]=result.rgb;return color==="red"?r>210&&b<40:b>210&&r<40;},{timeout:10_000,interval:200,timeoutMsg:`actual native screenshot never showed decoded ${color} video`});report(`${name}.json`,result);return result!;}
async function revoked(url:string):Promise<void>{const parsed=new URL(url);if(parsed.hostname!=="127.0.0.1"||!/^\/media\/[a-f0-9]{48}$/.test(parsed.pathname))throw new Error("Refusing to query an unowned media URL");await browser.waitUntil(async()=>new Promise<boolean>((resolve,reject)=>{const request=http.request(parsed,{method:"HEAD",agent:false},response=>{response.resume();response.on("end",()=>resolve(response.statusCode===404));});request.on("error",reject);request.end();}),{timeoutMsg:"departed native media capability remains usable"});}
async function cleanup(identity?:NativeFileIdentity){let stats=await videoStats();await browser.waitUntil(async()=>{stats=await videoStats();return stats.active_leases===0&&stats.open_workers===0&&stats.active_streams===0&&stats.active_connections===0&&(!identity||mediaFileHandles(identity).length===0);},{timeout:15_000,timeoutMsg:"video capability, read worker, stream, connection or actual file handle survived unload"});return stats;}

(enabled?describe:describe.skip)("native video playback and bounded streaming (#970)",function(){
  this.bail(true);
  before(async()=>{
    const profile=process.env.TAURI_NATIVE_VIDEO_PROFILE!;
    if(process.env.GDK_BACKEND!=="x11"||process.env.WAYLAND_DISPLAY||!process.env.DISPLAY||!process.env.DBUS_SESSION_BUS_ADDRESS||process.env.XDG_CONFIG_HOME!==path.join(profile,"config"))throw new Error("Video qualification requires the owned private Xvfb/D-Bus/XDG profile");
    const fixtures=process.env.TAURI_NATIVE_VIDEO_FIXTURES!;const metadata=JSON.parse(fs.readFileSync(path.join(fixtures,"fixtures.json"),"utf8"));
    expect(metadata.sparsePadding).toBe(false);expect(metadata.files["streaming-noise.webm"].allocatedBytes).toBeGreaterThanOrEqual(1024**3);
    directory=fs.realpathSync(createNativeFixtureDirectory("native-video-970-"));
    colors=path.join(directory,"0-colors.webm");revision=path.join(directory,"1-revision.webm");large=path.join(directory,"2-large-noise.webm");text=path.join(directory,"3-readme.txt");
    fs.copyFileSync(path.join(fixtures,"colors.webm"),colors);fs.copyFileSync(colors,revision);fs.linkSync(path.join(fixtures,"streaming-noise.webm"),large);
    fs.writeFileSync(text,"Non-video selection remains usable after media unload.\n");fs.writeFileSync(path.join(directory,"4-invalid.webm"),"not a video container");
    report("fixtures.json",{metadata,directory,sourceCommit:process.env.GITHUB_SHA,nativeBuildManifest:process.env.NATIVE_BUILD_MANIFEST});
    await browser.setWindowSize(1280,900);await navigateTo(directory);await videoCommand("Details View");
    await browser.execute(()=>{const root=document.documentElement;root.dataset.e2eNativeVideoCsp="[]";window.addEventListener("securitypolicyviolation",event=>{const rows=JSON.parse(root.dataset.e2eNativeVideoCsp??"[]");rows.push({blockedURI:event.blockedURI,directive:event.effectiveDirective});root.dataset.e2eNativeVideoCsp=JSON.stringify(rows);});});
  });
  beforeEach(async()=>{await $(entryPathSelector(text)).click();await videoCommand("Reset Zoom");await videoCommand("Dock Preview Pane Right");await cleanup();});
  after(async()=>{await browser.releaseActions();await $(entryPathSelector(text)).click();const final=await cleanup();report("suite-cleanup.json",{completed:true,stats:final,sourceHash:await hashFile(colors),sourceCommit:process.env.GITHUB_SHA});});

  it("explicit play/pause, decoded red-to-blue seek, volume/mute and fullscreen work",async()=>{
    const hash=await hashFile(colors);const state=await select(colors);expect(state.paused).toBe(true);expect(state.currentTime).toBe(0);
    await playAndPause();await pixel("native-playing-red","red");await seekFour();await pixel("native-seek-blue","blue");
    await $('[aria-label="Mute video"]').click();expect((await videoState())?.muted).toBe(true);
    await rangeKeys('[aria-label="Video volume"]',5);expect((await videoState())?.volume).toBeCloseTo(0.25,5);expect((await videoState())?.muted).toBe(false);
    await $('[aria-label="View video fullscreen"]').click();await $(".preview-pane.fullscreen").waitForDisplayed();await pixel("native-fullscreen-blue","blue");
    const fullscreenControls=await browser.execute(()=>Array.from(document.querySelectorAll(".video-controls button,.video-controls input")).map(element=>{const rect=element.getBoundingClientRect();const x=rect.x+rect.width/2;const y=rect.y+rect.height/2;const hit=document.elementFromPoint(x,y);return {label:element.getAttribute("aria-label"),rect:rect.toJSON(),visibleWithinViewport:rect.width>0&&rect.height>0&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1,centerReachesControl:!!hit&&(hit===element||element.contains(hit)),hit:hit?.outerHTML.slice(0,300)};}));
    report("native-fullscreen-controls.json",fullscreenControls);expect(fullscreenControls.length).toBeGreaterThan(0);expect(fullscreenControls.every(control=>control.visibleWithinViewport&&control.centerReachesControl)).toBe(true);
    await $(".video-preview").click();await browser.keys("Home");await pixel("native-keyboard-start-red","red");
    await browser.keys(" ");await browser.waitUntil(async()=>!(await videoState())?.paused);await browser.keys(" ");expect((await videoState())?.paused).toBe(true);
    await browser.keys("Escape");await $(".preview-pane.fullscreen").waitForExist({reverse:true});expect(await hashFile(colors)).toBe(hash);
    const violations=await browser.execute(()=>JSON.parse(document.documentElement.dataset.e2eNativeVideoCsp??"[]"));report("csp.json",violations);expect(violations.filter((v:{directive:string})=>v.directive==="media-src")).toEqual([]);
  });

  it("controls remain operable in all three docks at app zoom 150%",async()=>{
    await select(colors);await videoCommand("Reset Zoom");for(let n=0;n<5;n++)await videoCommand("Zoom In");
    for(const dock of ["Right","Top","Bottom"]){await $(entryPathSelector(colors)).click();await videoCommand(`Dock Preview Pane ${dock}`);
      const bounds=await browser.execute(()=>{const pane=document.querySelector(".video-preview")!.getBoundingClientRect();return Array.from(document.querySelectorAll(".video-controls button,.video-controls input")).map(element=>{const r=element.getBoundingClientRect();return {label:element.getAttribute("aria-label"),inside:r.width>0&&r.height>0&&r.x>=pane.x-1&&r.right<=pane.right+1&&r.y>=pane.y-1&&r.bottom<=pane.bottom+1};});});expect(bounds.every(v=>v.inside)).toBe(true);
      await playAndPause();await seekFour();report(`native-dock-${dock.toLowerCase()}.json`,{bounds,state:await videoState()});await browser.saveScreenshot(path.join(proof,`native-dock-${dock.toLowerCase()}-150.png`));
    }
  });

  it("selection replacement and preview hiding stop media and revoke actual capabilities",async()=>{
    const first=await select(colors);await $('[aria-label="Play video"]').click();const firstIdentity=nativeFileIdentity(colors);const token=await observeRetirement();
    await select(revision);expect(await retiredObservation(token)).toMatchObject({paused:true,src:null});await revoked(first.src!);expect(mediaFileHandles(firstIdentity)).toEqual([]);
    const second=(await videoState())!;const secondIdentity=nativeFileIdentity(revision);const hidden=await observeRetirement();await $(entryPathSelector(revision)).click();await videoCommand("Toggle Preview Pane");
    await $(".video-preview").waitForExist({reverse:true});expect(await retiredObservation(hidden)).toMatchObject({paused:true,src:null});await revoked(second.src!);report("unload.json",{selectionOldUrlRevoked:true,hiddenOldUrlRevoked:true,cleanup:await cleanup(secondIdentity)});
  });

  it("refreshing a changed selected file retires the old revision and decodes new bytes",async()=>{
    const before=await select(revision);await playAndPause();await pixel("native-before-revision-red","red");const identity=nativeFileIdentity(revision);const retired=await observeRetirement();
    const staged=path.join(directory,"replacement.tmp");fs.copyFileSync(path.join(process.env.TAURI_NATIVE_VIDEO_FIXTURES!,"replacement.webm"),staged);fs.renameSync(staged,revision);
    await $(entryPathSelector(revision)).click();await videoCommand("Refresh");await browser.waitUntil(async()=>{const value=await videoState();return !!value&&value.src!==before.src&&value.readyState>=1;});await ready();
    expect(await retiredObservation(retired)).toMatchObject({paused:true,src:null});await revoked(before.src!);expect(mediaFileHandles(identity)).toEqual([]);await playAndPause();await pixel("native-refreshed-revision-blue","blue");
    report("revision.json",{oldUrl:before.src,newUrl:(await videoState())?.src,oldCapabilityRevoked:true,replacementHash:await hashFile(revision)});
  });

  it("starts and seeks an encoded file over 1 GiB without whole-file buffering",async()=>{
    const size=fs.statSync(large).size;expect(size).toBeGreaterThanOrEqual(1024**3);const baseline=await videoStats();const sampler=sampleVideoResources();
    let measurement:ReturnType<typeof sampler.stop>|undefined;
    try{
      const start=Date.now();const initial=await select(large);const startupToMetadataMs=Date.now()-start;
      await playAndPause();const decoded=await screenshotPixels(path.join(proof,"native-large-decoded-noise.png"),32);expect(Math.max(...decoded.deviation)).toBeGreaterThan(15);
      const afterStartup=await videoStats();const slider=$('[aria-label="Seek video"]');const rect=await slider.getSize();const seekStart=Date.now();await slider.click({x:Math.round(rect.width*0.25),y:0});
      await browser.waitUntil(async()=>{const value=await videoState();return !!value&&!value.seeking&&value.readyState>=2&&value.currentTime>initial.duration*0.55&&value.currentTime<initial.duration*0.95;},{timeout:20_000,timeoutMsg:"actual large-video decoder did not complete the distant native slider seek"});
      const seekToDecodedMs=Date.now()-seekStart;const seeked=await screenshotPixels(path.join(proof,"native-large-distant-seek.png"),32);expect(Math.max(...seeked.deviation)).toBeGreaterThan(15);
      const afterSeek=await videoStats();const identity=nativeFileIdentity(large);expect(mediaFileHandles(identity).length).toBeGreaterThan(0);const oldUrl=(await videoState())!.src!;
      await $(entryPathSelector(text)).click();await revoked(oldUrl);const settled=await cleanup(identity);measurement=sampler.stop();
      const peakRssGrowthBytes=Math.max(...measurement.samples.map(v=>v.totalRssBytes))-measurement.samples[0].totalRssBytes;
      const readBytes=afterSeek.read_bytes-baseline.read_bytes;const metrics={size,startupToMetadataMs,seekToDecodedMs,initial,seeked,baseline,afterStartup,afterSeek,settled,readBytes,peakRssGrowthBytes,...measurement};report("large-file-performance.json",metrics);
      expect(measurement.errors).toEqual([]);expect(afterSeek.read_calls).toBeGreaterThan(afterStartup.read_calls);expect(afterSeek.max_chunk_bytes).toBeLessThanOrEqual(64*1024);expect(readBytes).toBeGreaterThan(0);expect(readBytes).toBeLessThan(size/2);expect(peakRssGrowthBytes).toBeLessThan(256*1024*1024);
    }finally{if(!measurement)report("large-file-interrupted-resources.json",sampler.stop());}
  });

  it("a real invalid container reports failure and releases its native source",async()=>{
    await $(entryPathSelector(path.join(directory,"4-invalid.webm"))).click();if(!await $(".preview-pane").isDisplayed())await videoCommand("Toggle Preview Pane");await $(".video-message").waitForDisplayed();
    await browser.waitUntil(async()=>/codec|format|unavailable|Cannot load/i.test(await $(".video-message").getText()));expect(await $('[aria-label="Play video"]').isEnabled()).toBe(false);await browser.saveScreenshot(path.join(proof,"native-invalid-container.png"));report("invalid-container.json",{message:await $(".video-message").getText(),stats:await cleanup()});
  });
});
