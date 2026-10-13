import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyNativeJobs, mergeNativeJobEvent, adoptNativeSnapshot, validNativeJob, type NativeJobRecord } from "$lib/domain/native-plugin-jobs";
import { createNativePluginJobsController } from "$lib/state/native-plugin-jobs";
import { jobsStore, isJobActive } from "$lib/state/jobs.svelte";
import { jobDuration } from "$lib/domain/image-job-progress";
import { createPluginJobsController, windowJobSink } from "$lib/state/plugin-jobs";
vi.mock("$lib/plugins/installed", async (original) => ({ ...await original<object>(), installedPackages: () => [{ manifest: { id: "consumer", contributions: ["image-contribution"] } }] }));
const record = (n = 1, revision = 1, state: NativeJobRecord["state"] = "running"): NativeJobRecord => ({
  jobKey: n.toString(16).padStart(48,"0"), owner: { packageId: "consumer", digest: "a".repeat(64), incarnation: 3 },
  operationId: `operation-${n}`, jobId: 9000+n, kind: "openai-image", label: "image.png", originWindow: "main", revision,
  createdAtMs: 1, updatedAtMs: 2, state, ...(state === "completed" ? { outputPath: "/generated/image.png", runId: 8 } : {}),
});
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((done) => { resolve=done; }); return { promise, resolve }; }
afterEach(() => { jobsStore.applyNative([]); jobsStore.configureNativeControls(null); for (const j of [...jobsStore.jobs]) jobsStore.removeJob(j.id); });
describe("native job revisions and ownership", () => {
  it.each(["completed", "error"] as const)("accepts an authorized adoption followed by %s without reloading", (state) => {
    const original = record(1, 1, "accepting");
    const before = mergeNativeJobEvent(emptyNativeJobs(), { type: "updated", job: original });
    const adopted = { ...record(1, 2, state), ownershipEpoch: 1, owner: { ...original.owner, digest: "b".repeat(64), incarnation: 4 } };
    const after = mergeNativeJobEvent(before, { type: "updated", job: adopted });
    expect(after.jobs.get(original.jobKey)).toEqual(adopted);
    for (const stale of [
      { ...original, revision: 3 },
      { ...original, revision: 3, ownershipEpoch: 1 },
      { ...adopted, revision: 3, ownershipEpoch: 0 },
      { ...adopted, revision: 3, ownershipEpoch: -1 },
    ]) expect(mergeNativeJobEvent(after, { type: "updated", job: stale })).toBe(after);
  });

  it.each([
    ["discarded", "stopped"],
    ["error", "delivery_failed"],
    ["error", "storage_full"],
    ["error", "failed"],
    ["error", null],
    ["cancelled", "cancelled"],
    ["cancelled", null],
    ["discarded", "discarded"],
    ["discarded", "provider_result_discarded"],
    ["discarded", null],
  ] as const)("accepts proof-backed host completion without an observed run from %s/%s", (state, phase) => {
    const settled = { ...record(1, 2, state), phase, runId: null, settledAtMs: 2 };
    const before = mergeNativeJobEvent(emptyNativeJobs(), { type: "updated", job: settled });
    const completed = { ...record(1, 3, "completed"), phase: "complete", runId: null, settledAtMs: 2 };
    expect(mergeNativeJobEvent(before, { type: "updated", job: completed }).jobs.get(settled.jobKey)).toEqual(completed);
    for (const invalid of [
      { ...completed, revision: settled.revision },
      { ...completed, revision: settled.revision - 1 },
      { ...completed, operationId: "other-operation" },
      { ...completed, outputPath: undefined },
      { ...completed, runId: 0 },
      { ...completed, runId: Number.MAX_SAFE_INTEGER + 1 },
      { ...completed, owner: { ...completed.owner, incarnation: 4 } },
    ]) expect(mergeNativeJobEvent(before, { type: "updated", job: invalid })).toBe(before);
  });
  it("corrects a settled Unknown to its late output without reopening other terminal outcomes", () => {
    const stopped = { ...record(1, 2, "discarded"), phase: "stopped", settledAtMs: 2 };
    const before = mergeNativeJobEvent(emptyNativeJobs(), { type: "updated", job: stopped });
    const completed = { ...record(1, 3, "completed"), phase: "complete", settledAtMs: 2 };
    const corrected = mergeNativeJobEvent(before, { type: "updated", job: completed });
    expect(corrected.jobs.get(stopped.jobKey)).toMatchObject({ state: "completed", outputPath: "/generated/image.png", runId: 8 });
    const deliveryFailed = mergeNativeJobEvent(emptyNativeJobs(), { type: "updated", job: { ...stopped, state: "error", phase: "delivery_failed" } });
    expect(mergeNativeJobEvent(deliveryFailed, { type: "updated", job: completed }).jobs.get(stopped.jobKey)?.state).toBe("completed");
    for (const job of [record(1, 4), { ...completed, outputPath: undefined }, { ...completed, runId: 0 }, { ...completed, owner: { ...completed.owner, packageId: "provider" } }]) {
      expect(mergeNativeJobEvent(before, { type: "updated", job })).toBe(before);
    }
    for (const state of ["error", "cancelled", "completed"] as const) {
      const retained = mergeNativeJobEvent(emptyNativeJobs(), { type: "updated", job: { ...stopped, state } });
      expect(mergeNativeJobEvent(retained, { type: "updated", job: { ...completed, state: "discarded" } })).toBe(retained);
    }
    const explicit = mergeNativeJobEvent(emptyNativeJobs(), { type: "updated", job: { ...stopped, phase: "provider_result_discarded" } });
    expect(mergeNativeJobEvent(explicit, { type: "updated", job: completed }).jobs.get(stopped.jobKey)).toEqual(completed);
  });
  it("adopts a prepared estimate key once and rejects a changed cohort", () => {
    let state = mergeNativeJobEvent(emptyNativeJobs(), {type:"updated",job:record()});
    const pinned = {...record(1,2),estimateKey:"image-v1:fast"};
    state = mergeNativeJobEvent(state,{type:"updated",job:pinned});
    expect(state.jobs.get(pinned.jobKey)?.estimateKey).toBe("image-v1:fast");
    expect(mergeNativeJobEvent(state,{type:"updated",job:{...pinned,revision:3,estimateKey:"different"}})).toBe(state);
    expect(validNativeJob({...pinned,estimateKey:"x".repeat(128)})).toBe(true);
    for(const estimateKey of ["", "x".repeat(129),"has space","雪",1]) expect(validNativeJob({...pinned,estimateKey})).toBe(false);
  });
  it("ignores stale progress, duplicate events and identity changes after completion", () => {
    let state = mergeNativeJobEvent(emptyNativeJobs(), { type:"updated",job:record() });
    state = mergeNativeJobEvent(state, { type:"updated",job:record(1,3,"completed") });
    for (const job of [record(1,2),record(1,3,"completed"),record(1,4),{...record(1,5,"completed"),owner:{...record().owner,packageId:"provider"}},{...record(1,6,"completed"),kind:"foreign-kind"}]) expect(mergeNativeJobEvent(state,{type:"updated",job})).toBe(state);
    expect(state.jobs.get(record().jobKey)?.state).toBe("completed");
    expect(adoptNativeSnapshot(state,{originWindow:"main",watermark:2,jobs:[record(1,2)]})).toBe(state);
  });
  it("keeps dismissal tombstones and never allows a foreign kind to reuse a native numeric identity", () => {
    let state=mergeNativeJobEvent(emptyNativeJobs(),{type:"updated",job:record(1,3,"completed")});
    expect(mergeNativeJobEvent(state,{type:"updated",job:{...record(2,4),jobId:record().jobId,kind:"foreign-kind"}})).toBe(state);
    state=mergeNativeJobEvent(state,{type:"dismissed",jobKey:record().jobKey,revision:4});
    expect(state.jobs.size).toBe(0);
    expect(mergeNativeJobEvent(state,{type:"updated",job:record(1,3,"completed")})).toBe(state);
  });
  it("rejects malformed values and JS-unsafe identity or revision numbers",()=>{
    expect(validNativeJob(record())).toBe(true);
    for(const bad of [{...record(),revision:Number.MAX_SAFE_INTEGER+1},{...record(),owner:{...record().owner,incarnation:0}},{...record(),label:"x".repeat(257)},{...record(),state:"provider-success"},{...record(),jobKey:"backend-selected-key"}]) expect(validNativeJob(bad)).toBe(false);
  });
});
describe("owned native subscription",()=>{
  it.each(["discarded", "error", "cancelled"] as const)("shows repaired %s history as Complete silently, without reload", async (state) => {
    let receive!: (value: unknown) => void;
    const stopped = { ...record(1, 2, state), phase: state === "error" ? "failed" : null, error: state === "error" ? "Historical delivery failure" : null, runId: null, settledAtMs: 2 };
    const toast = vi.fn();
    const snapshot = vi.fn(async () => ({ originWindow: "main", watermark: 2, jobs: [stopped] }));
    const controller = createNativePluginJobsController({ watch: async fn => { receive = fn; return () => {}; }, snapshot, apply: records => jobsStore.applyNative(records), toast, error: () => {} });
    await controller.init();
    receive({ type: "updated", job: { ...record(1, 3, "completed"), phase: "complete", runId: null, settledAtMs: 2 } });
    expect(jobsStore.jobs[0]).toMatchObject({ status: "completed", outputPath: "/generated/image.png", error: undefined });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
    receive({ type: "updated", job: record(1, 4) });
    expect(jobsStore.jobs[0].status).toBe("completed");
    controller.dispose();
  });
  it("subscribes before snapshot, merges the pending fresh completion and toasts once only in its origin window",async()=>{
    const read=deferred<{originWindow:string;watermark:number;jobs:NativeJobRecord[]}>();let receive!:(v:unknown)=>void;const calls:string[]=[],toasts:NativeJobRecord[]=[],applied:NativeJobRecord[][]=[];
    const controller=createNativePluginJobsController({watch:async(fn)=>{calls.push("watch");receive=fn;return()=>{};},snapshot:async()=>{calls.push("snapshot");return read.promise;},apply:(v)=>applied.push([...v]),toast:(v)=>toasts.push(v),error:()=>{}});
    const initial=controller.init();await vi.waitFor(()=>expect(calls).toEqual(["watch","snapshot"]));
    receive({type:"updated",job:record(1,2,"completed")});
    read.resolve({originWindow:"main",watermark:1,jobs:[record()]});await initial;
    expect(applied.at(-1)?.[0].state).toBe("completed");expect(toasts).toHaveLength(1);
    receive({type:"updated",job:record(1,2,"completed")});receive({type:"updated",job:record(1,1)});
    receive({type:"updated",job:{...record(2,3,"completed"),originWindow:"other-window"}});
    expect(toasts).toHaveLength(1);controller.dispose();
  });
  it("rehydrates without a plugin frontend or completion noise and ignores callbacks after disposal",async()=>{
    let receive!:(v:unknown)=>void;const apply=vi.fn(),toast=vi.fn(),stop=vi.fn();
    const controller=createNativePluginJobsController({watch:async(fn)=>{receive=fn;return stop;},snapshot:async()=>({originWindow:"main",watermark:4,jobs:[record(1,4,"completed"),record(2,3,"needs_attention")]}),apply,toast,error:()=>{}});
    await controller.init();expect(apply.mock.calls.at(-1)?.[0]).toHaveLength(2);expect(toast).not.toHaveBeenCalled();
    controller.dispose();receive({type:"updated",job:record(3,5,"completed")});expect(apply).toHaveBeenCalledTimes(1);expect(stop).toHaveBeenCalledTimes(1);
  });
  it("releases a delayed listener and permits an explicit retry after subscription failure",async()=>{
    const stop=vi.fn();const listener=deferred<()=>void>();const snapshot=vi.fn(async()=>({originWindow:"main",watermark:0,jobs:[]}));
    const controller=createNativePluginJobsController({watch:()=>listener.promise,snapshot,apply:()=>{},toast:()=>{},error:()=>{}});
    const initial=controller.init();controller.dispose();listener.resolve(stop);await initial;
    expect(stop).toHaveBeenCalledTimes(1);expect(snapshot).not.toHaveBeenCalled();
    let attempts=0;const recovered=createNativePluginJobsController({watch:async()=>{if(++attempts===1)throw Error("listener failed");return()=>{};},snapshot,apply:()=>{},toast:()=>{},error:()=>{}});
    await recovered.init();await recovered.refresh();expect(snapshot).toHaveBeenCalledTimes(1);recovered.dispose();
  });
});
describe("native job store integration",()=>{
  it("completion before start reply retains one completed native job while adding only renderer detail and compatible Retry",async()=>{
    const completed=record(1,2,"completed");jobsStore.applyNative([completed]);
    const native={init:async()=>{},dispose:()=>{},has:(kind:string,id:number)=>kind===completed.kind&&id===completed.jobId};
    const controller=createPluginJobsController({...windowJobSink,listen:async()=>()=>{},native});
    const retry=async()=>({ok:false as const,error:"not started"});
    await controller.accept({kind:"openai-image",owner:"image-contribution",label:"renderer-label.png",detail:"Dirty original prompt",retry},async()=>({ok:true,data:completed.jobId}));
    expect(jobsStore.jobs).toHaveLength(1);expect(jobsStore.jobs[0]).toMatchObject({status:"completed",jobKey:completed.jobKey,revision:2,detail:"Dirty original prompt",owner:"image-contribution",nativePackageOwner:"consumer"});
    expect(jobsStore.jobs[0].retry).toBeTypeOf("function");jobsStore.dropRetries("image-contribution");expect(jobsStore.jobs[0].retry).toBeUndefined();await controller.dispose();
  });
  it("a foreign owner or wrong kind cannot attach a Retry to a consumer job",()=>{
    jobsStore.applyNative([record()]);const retry=async()=>({ok:true as const,data:99});
    jobsStore.addJob(record().jobId,"forged","d","openai-image","image",{owner:"provider",nativeOwner:"provider",retry});
    jobsStore.addJob(record().jobId,"forged","d","provider-kind","image",{owner:"image-contribution",nativeOwner:"consumer",retry});
    windowJobSink.add({ id: record().jobId, kind: "openai-image", label: "forged", detail: "unresolved package authority", owner: "consumer", retry });
    expect(jobsStore.jobs).toHaveLength(1);expect(jobsStore.jobs[0].retry).toBeUndefined();
    jobsStore.completeJob(record().jobId,"/forged.png");jobsStore.failJob(record().jobId,"forged");expect(jobsStore.jobs[0].status).toBe("running");
  });
  it("an unresolved renderer registration arriving first cannot supply native Retry or detail through matching package text", () => {
    const retry=async()=>({ok:true as const,data:99});
    windowJobSink.add({ id: record().jobId, kind: "openai-image", label: "forged", detail: "unresolved package authority", owner: "consumer", retry });
    jobsStore.applyNative([record()]);
    expect(jobsStore.jobs).toHaveLength(1); expect(jobsStore.jobs[0]).toMatchObject({ label: "image.png", detail: "", nativePackageOwner: "consumer" });
    expect(jobsStore.jobs[0].retry).toBeUndefined();
  });
  it("recovery remains active; cancel waits for native outcome and dismiss failure keeps the terminal item",async()=>{
    jobsStore.applyNative([record(1,1,"needs_attention")]);expect(isJobActive(jobsStore.jobs[0])).toBe(true);jobsStore.clearCompleted();expect(jobsStore.jobs).toHaveLength(1);
    const cancel=deferred<void>();jobsStore.configureNativeControls({cancel:()=>cancel.promise,dismiss:async()=>{throw Error("Disk unavailable");},resume:async()=>{}});
    jobsStore.applyNative([record(1,2)]);const requested=jobsStore.controlJob(record().jobId,"cancel");expect(jobsStore.jobs[0].status).toBe("running");
    cancel.resolve();await requested;expect(jobsStore.jobs[0]).toMatchObject({status:"running",cancelRequested:true});
    jobsStore.applyNative([record(1,3,"cancelled")]);expect(isJobActive(jobsStore.jobs[0])).toBe(false);expect(jobsStore.jobs[0].retry).toBeUndefined();
    await jobsStore.controlJob(record().jobId,"dismiss");expect(jobsStore.jobs[0]).toMatchObject({status:"cancelled",controlError:"Disk unavailable"});
  });
});
describe("settled recovery presentation", () => {
  const parked = (n: number, revision: number, phase: string): NativeJobRecord => ({ ...record(n, revision, "needs_attention"), phase });
  it("a stopped or discarded job is dismissable and leaves active capacity; unresolved attention is not", () => {
    let state = emptyNativeJobs();
    for (let n = 1; n <= 128; n++) state = mergeNativeJobEvent(state, { type: "updated", job: parked(n, n, n % 2 ? "stopped" : "provider_result_discarded") });
    // 128 explicit stops never block a new native job from presentation.
    state = mergeNativeJobEvent(state, { type: "updated", job: record(200, 200) });
    expect(state.jobs.has(record(200).jobKey)).toBe(true);
    state = mergeNativeJobEvent(state, { type: "dismissed", jobKey: parked(1, 1, "stopped").jobKey, revision: 201 });
    expect(state.jobs.has(parked(1, 1, "stopped").jobKey)).toBe(false);
    state = mergeNativeJobEvent(state, { type: "updated", job: parked(300, 202, "needs_attention") });
    expect(mergeNativeJobEvent(state, { type: "dismissed", jobKey: record(300).jobKey, revision: 203 })).toBe(state);
  });
  it("Clear Completed dismisses a stopped job natively while unresolved attention stays active", async () => {
    const dismissed: string[] = [];
    jobsStore.configureNativeControls({ cancel: async () => {}, dismiss: async (key) => { dismissed.push(key); }, resume: async () => {} });
    jobsStore.applyNative([parked(1, 1, "stopped"), parked(2, 2, "needs_attention")]);
    expect(jobsStore.jobs.map(isJobActive)).toEqual([false, true]);
    expect(jobsStore.hasRunningJobs).toBe(true);
    jobsStore.clearCompleted();
    await vi.waitFor(() => expect(dismissed).toEqual([parked(1, 1, "stopped").jobKey]));
  });
  it("a settled job's duration is its host-recorded settled time, not its last update, and does not move with the clock", () => {
    // Updated (e.g. dismissed) long after it settled at t=39s.
    jobsStore.applyNative([
      { ...record(1, 1, "completed"), createdAtMs: 1_000, settledAtMs: 39_000, updatedAtMs: 900_000 },
      { ...record(2, 2, "completed"), createdAtMs: 1_000, updatedAtMs: 900_000 },
      { ...record(3, 3, "running"), createdAtMs: 1_000 },
    ]);
    const [settled, legacy, active] = jobsStore.jobs;
    expect(jobDuration(settled, 39_000)).toBe(38_000);
    expect(jobDuration(settled, 5_000_000)).toBe(38_000);
    expect(jobDuration(legacy, 5_000_000)).toBeNull();
    expect(jobDuration(active, 61_000)).toBe(60_000);
    expect(jobDuration(active, 121_000)).toBe(120_000);
  });
});

it("publishes the delivery-loss report when a settled Unknown later succeeds and its consumer is explicitly removed", () => {
  const stopped = { ...record(1, 2, "discarded"), phase: "stopped" };
  const before = mergeNativeJobEvent(emptyNativeJobs(), { type: "updated", job: stopped });
  const removed = { ...stopped, revision: 3, state: "error" as const, phase: "consumer_removed", error: "One image could not be delivered because its consumer plugin was disabled or uninstalled" };
  const next = mergeNativeJobEvent(before, { type: "updated", job: removed });
  expect(next.jobs.get(stopped.jobKey)).toEqual(removed);
  expect(mergeNativeJobEvent(next, { type: "updated", job: stopped }).jobs.get(stopped.jobKey)).toEqual(removed);
});

it("shows the original output after storage-full recovery completes without a reload", () => {
  const running = record(1, 2, "running");
  const before = mergeNativeJobEvent(emptyNativeJobs(), { type: "updated", job: running });
  const full = { ...running, revision: 3, state: "error" as const, phase: "storage_full", error: "AI image storage is full; recovery will retry automatically when capacity is available" };
  const waiting = mergeNativeJobEvent(before, { type: "updated", job: full });
  expect(waiting.jobs.get(full.jobKey)?.error).toContain("storage is full");
  const complete = { ...full, revision: 4, state: "completed" as const, phase: "succeeded", error: null, outputPath: "/generated/original.png", runId: 7 };
  expect(mergeNativeJobEvent(waiting, { type: "updated", job: complete }).jobs.get(full.jobKey)).toEqual(complete);
});

describe("optional job presentation projection", () => {
  const cost = { amount: "0.045", currency: "USD", estimated: true, source: "bfl.credits" };
  const reveal = { kind: "file" as const, path: "/generated/image.png" };
  it("projects cost and reveal while loading old native records", () => {
    jobsStore.applyNative([{ ...record(1, 2, "completed"), cost, reveal }, record(2, 3, "completed")]);
    expect(jobsStore.jobs[0]).toMatchObject({ cost, reveal });
    expect(jobsStore.jobs[1].cost).toBeUndefined(); expect(jobsStore.jobs[1].reveal).toBeUndefined();
  });
  it("drops malformed optional metadata without failing the completed job", () => {
    jobsStore.applyNative([{ ...record(1, 2, "completed"), cost: { ...cost, amount: "-1" }, reveal: { kind: "file", path: "" } }]);
    expect(jobsStore.jobs[0].status).toBe("completed"); expect(jobsStore.jobs[0].cost).toBeUndefined(); expect(jobsStore.jobs[0].reveal).toBeUndefined();
  });
  it("projects validated legacy completion metadata and includes cost in its toast", async () => {
    const handlers = new Map<string, (value: any) => void>(); const messages: string[] = [];
    const controller = createPluginJobsController({ ...windowJobSink, listen: async (name, handler) => { handlers.set(name, handler); return () => {}; }, success: message => messages.push(message), refresh: async () => {} });
    await controller.accept({ kind: "openai-image", label: "image.png", detail: "" }, async () => ({ ok: true, data: 22 }));
    handlers.get("openai-image-complete")!({ jobId: 22, outputPath: reveal.path, cost, reveal });
    expect(jobsStore.jobs.find(job => job.id === 22)).toMatchObject({ status: "completed", cost, reveal });
    expect(messages).toEqual(["image.png complete: image.png · ≈US$0.05"]); await controller.dispose();
  });
});
