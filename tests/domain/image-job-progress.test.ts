import { describe, expect, it } from "vitest";
import { imageJobProgress, jobDuration, formatJobDuration, type ImageJobTiming } from "$lib/domain/image-job-progress";
const job: ImageJobTiming = {source:"openai-image",presentation:"image",status:"running",startTime:0};
const completed = (duration:number,source="openai-image"): ImageJobTiming => ({...job,source,status:"completed",endTime:duration});
describe("estimated image progress",()=>{
  it("shows a cold-start estimate and never signals completion for a running request",()=>{
    expect(imageJobProgress(job,[],60_000)).toMatchObject({elapsedMs:60_000,percent:50,remainingMs:60_000,overdue:false});
    expect(imageJobProgress(job,[],240_000)).toMatchObject({percent:95,remainingMs:0,overdue:true});
  });
  it("uses the median successful image durations from the same provider source",()=>{
    const history=[completed(30_000),completed(90_000),completed(3_000_000),completed(1000,"other"),{...completed(1000),status:"error" as const},completed(NaN)];
    expect(imageJobProgress(job,history,45_000)).toMatchObject({percent:50,remainingMs:45_000});
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
