import { describe, expect, it } from "vitest";
import { imageJobProgress, imageJobEstimateLabel, jobDuration, formatJobDuration, type ImageJobTiming } from "$lib/domain/image-job-progress";
const job: ImageJobTiming = {source:"openai-image",presentation:"image",status:"running",startTime:0};
const completed = (duration:number,source="openai-image"): ImageJobTiming => ({...job,source,status:"completed",endTime:duration});
describe("estimated image progress",()=>{
  it("uses matching keys after three samples, otherwise source history then the default",()=>{
    const keyed = {...job, startTime:300_000, estimateKey:"fast"};
    const fast = [30_000,40_000,50_000].map(ms=>({...completed(ms),estimateKey:"fast"}));
    const slow = [200_000,210_000,220_000].map(ms=>({...completed(ms),estimateKey:"slow"}));
    expect(imageJobProgress(keyed,[...fast,...slow],320_000).remainingMs).toBe(20_000);
    expect(imageJobProgress(keyed,[...fast.slice(0,2),...slow],300_000).expectedMs).toBe(200_000);
    expect(imageJobProgress(keyed,fast.slice(0,2),300_000).expectedMs).toBe(120_000);
  });
  it("takes the latest twenty completions, independent of array order",()=>{
    const history = Array.from({length:43},(_,i)=>({...completed(i<23?1_000:60_000),startTime:i*100_000,endTime:i*100_000+(i<23?1_000:60_000)}));
    expect(imageJobProgress(job,history.toReversed(),5_000_000).expectedMs).toBe(60_000);
    expect(history[0].endTime).toBe(1000);
  });
  it("drops malformed, extreme, future and unsuccessful durations",()=>{
    const valid=[completed(20_000),completed(30_000),completed(40_000)];
    const invalid=[completed(999),completed(3_600_001),completed(Infinity),completed(NaN),completed(-1),{...completed(10_000),startTime:-1000}, {...completed(10_000),startTime:0.5}, {...completed(10_000),startTime:"0" as unknown as number}, {...completed(10_000),endTime:undefined},completed(Number.MAX_SAFE_INTEGER+1),completed(1_000_000),...["error","cancelled","discarded","unknown","running"].map(status=>({...completed(10_000),status}))];
    expect(imageJobProgress(job,[...valid,...invalid],100_000).expectedMs).toBe(30_000);
    expect(imageJobProgress(job,[completed(1_000),completed(3_600_000),completed(60_000)],4_000_000).expectedMs).toBe(60_000);
  });
  it("shows a cold-start estimate and never signals completion for a running request",()=>{
    expect(imageJobProgress(job,[],60_000)).toMatchObject({elapsedMs:60_000,percent:50,remainingMs:60_000,overdue:false});
    expect(imageJobProgress(job,[],240_000)).toMatchObject({percent:95,remainingMs:0,overdue:true});
    expect(imageJobEstimateLabel(imageJobProgress(job,[],240_000))).toBe("Estimate · longer than usual");
    expect(imageJobEstimateLabel(imageJobProgress(job,[],60_000))).toBe("Estimate · ~1m 0s remaining");
  });
  it("uses the median successful image durations from the same provider source",()=>{
    const history=[completed(30_000),completed(90_000),completed(3_000_000),completed(1000,"other"),{...completed(1000),status:"error" as const},completed(NaN)];
    expect(imageJobProgress({...job,startTime:4_000_000},history,4_045_000)).toMatchObject({percent:50,remainingMs:45_000});
  });
  it("stops elapsed time at termination and reports completion only on success",()=>{
    expect(imageJobProgress(completed(60_000),[],200_000)).toMatchObject({elapsedMs:60_000,percent:100});
    expect(imageJobProgress({...job,status:"error",endTime:30_000},[],200_000)).toMatchObject({elapsedMs:30_000,percent:25});
    expect(imageJobProgress(job,[],NaN).elapsedMs).toBeNull();
    expect(imageJobProgress(job,[],-1).elapsedMs).toBe(0);
    expect(formatJobDuration(61_000)).toBe("1m 1s");
  });
});
describe("job duration",()=>{
  const at=(over:Partial<ImageJobTiming>):ImageJobTiming=>({...job,startTime:1_000,...over});
  it("ticks with the clock while the job is active",()=>{
    expect(jobDuration(at({status:"running"}),39_000)).toBe(38_000);
    expect(jobDuration(at({status:"running"}),99_000)).toBe(98_000);
    expect(jobDuration(at({status:"needs_attention"}),5_000)).toBe(4_000);
  });
  it.each([
    ["completed",undefined],["error",undefined],["cancelled",undefined],["discarded",undefined],
    ["needs_attention","stopped"],["needs_attention","provider_result_discarded"],
  ])("freezes a %s (%s) job at its settled time whatever the clock says",(status,phase)=>{
    const settled=at({status,phase,endTime:39_000});
    expect(jobDuration(settled,39_000)).toBe(38_000);
    expect(jobDuration(settled,39_000+10*60_000)).toBe(38_000);
    expect(imageJobProgress(settled,[],39_000+10*60_000).elapsedMs).toBe(38_000);
  });
  it("has no duration for a settled job whose end was never recorded, rather than a growing one",()=>{
    for(const status of ["completed","error","discarded"]) expect(jobDuration(at({status}),1e9)).toBeNull();
    expect(jobDuration(at({status:"needs_attention",phase:"stopped"}),1e9)).toBeNull();
    expect(imageJobProgress(at({status:"error"}),[],1e9)).toMatchObject({elapsedMs:null,percent:0});
  });
  it("clamps clock skew and rejects malformed timestamps",()=>{
    expect(jobDuration(at({status:"completed",endTime:500}),9_000)).toBe(0);
    expect(jobDuration(at({status:"running"}),500)).toBe(0);
    expect(jobDuration(at({status:"completed",endTime:NaN}),9_000)).toBeNull();
    expect(jobDuration(at({status:"completed",endTime:Infinity}),9_000)).toBeNull();
    expect(jobDuration(at({status:"running"}),NaN)).toBeNull();
    expect(jobDuration(at({startTime:NaN,status:"running"}),9_000)).toBeNull();
    expect(jobDuration(at({status:"running",endTime:2_000}),9_000)).toBe(8_000);
  });
});
