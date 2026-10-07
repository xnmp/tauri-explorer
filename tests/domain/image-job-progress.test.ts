import { describe, expect, it } from "vitest";
import { imageJobProgress, formatJobDuration, type ImageJobTiming } from "$lib/domain/image-job-progress";
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
    expect(imageJobProgress(job,[],NaN).elapsedMs).toBe(0);
    expect(imageJobProgress(job,[],-1).elapsedMs).toBe(0);
    expect(formatJobDuration(61_000)).toBe("1m 1s");
  });
});
