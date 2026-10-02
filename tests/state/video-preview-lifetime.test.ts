import { describe,expect,it,vi } from "vitest";
import { createVideoLoadJob } from "$lib/state/video-preview-lifetime";
import { createForegroundGate } from "$lib/state/page-foreground";
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(value=>resolve=value);return {promise,resolve};};
describe("video capability lifetime",()=>{
  it("parked previews acquire no resource until the window becomes foreground",async()=>{
    const gate=createForegroundGate(false);
    const begin=vi.fn(async()=>"capability");const prepare=vi.fn(async()=>"url");const release=vi.fn(async()=>{});
    const job=createVideoLoadJob("/movie.webm",{begin,prepare,release},gate);
    await Promise.resolve();expect(begin).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();
    await gate.enterForeground();const source=await job.promise;
    expect(source.url).toBe("url");source.release();expect(release.mock.calls).toEqual([["capability"]]);
  });
  it("cancels a parked preview without admitting it on later activation",async()=>{
    const gate=createForegroundGate(false);const begin=vi.fn(async()=>"capability");
    const prepare=vi.fn(async()=>"url");const release=vi.fn(async()=>{});
    const job=createVideoLoadJob("/movie.webm",{begin,prepare,release},gate);
    const outcome=expect(job.promise).rejects.toThrow("released");job.cancel();await outcome;
    await gate.enterForeground();expect(begin).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();
  });
  it("only the current selection is admitted when a parked window activates",async()=>{
    const gate=createForegroundGate(false);const begin=vi.fn(async()=>"capability");
    const prepare=vi.fn(async()=>"url");const release=vi.fn(async()=>{});const transport={begin,prepare,release};
    const old=createVideoLoadJob("/old.webm",transport,gate);
    const outcome=expect(old.promise).rejects.toThrow("released");old.cancel();await outcome;
    const current=createVideoLoadJob("/current.webm",transport,gate);await gate.enterForeground();
    const source=await current.promise;expect(prepare.mock.calls).toEqual([["capability","/current.webm"]]);source.release();
  });
  it("never starts file access when cancelled before registration completes",async()=>{
    const begun=deferred<string>();const prepare=vi.fn(async()=>"url");const release=vi.fn(async()=>{});
    const job=createVideoLoadJob("/movie.webm",{begin:()=>begun.promise,prepare,release});
    const outcome=expect(job.promise).rejects.toThrow("released");
    job.cancel();begun.resolve("capability");await outcome;
    expect(prepare).not.toHaveBeenCalled();expect(release.mock.calls).toEqual([["capability"]]);
  });
  it("releases a pending preparation once and refuses its late URL",async()=>{
    const prepared=deferred<string>();const release=vi.fn(async()=>{});
    const prepare=vi.fn(()=>prepared.promise);
    const job=createVideoLoadJob("/movie.webm",{begin:async()=>"capability",prepare,release});
    const outcome=expect(job.promise).rejects.toThrow("released");
    await Promise.resolve();expect(prepare).toHaveBeenCalledWith("capability","/movie.webm");
    job.cancel();job.cancel();prepared.resolve("http://old-video");await outcome;
    expect(release.mock.calls).toEqual([["capability"]]);
  });
  it("the adopted source and job share one release on disposal",async()=>{
    const release=vi.fn(async()=>{});
    const job=createVideoLoadJob("/movie.webm",{begin:async()=>"capability",prepare:async()=>"http://current",release});
    const source=await job.promise;expect(source.url).toBe("http://current");
    source.release();job.cancel();source.release();expect(release.mock.calls).toEqual([["capability"]]);
  });
  it("releases a failed preparation and preserves the actual error",async()=>{
    const release=vi.fn(async()=>{});
    const job=createVideoLoadJob("/missing.webm",{begin:async()=>"capability",prepare:async()=>{throw new Error("File deleted");},release});
    await expect(job.promise).rejects.toThrow("File deleted");expect(release.mock.calls).toEqual([["capability"]]);
  });
});
