import { describe, expect, it } from "vitest";
import { createAiOperationsController } from "$lib/state/ai-operations";
import { resolutionCopy, validAiOperations, type AiOperationsSnapshot } from "$lib/domain/ai-operations";
const retained = (): AiOperationsSnapshot => ({version:1,operations:[{operationId:"operation-1",consumerPackage:"consumer",providerPackage:"provider",createdAtMs:null,execution:"succeeded",delivery:"available",reason:"Consumer missing",canResume:true,canDiscard:true,canStop:false}]});
function deferred<T>() {let resolve!:(v:T)=>void;const promise=new Promise<T>((done)=>{resolve=done;});return{promise,resolve};}
describe("unresolved operation custody controls",()=>{
  it("events during failed discard cannot erase its actionable error while the receipt stays retained", async () => {
    let receive = () => {};
    const controller = createAiOperationsController({ read: async () => retained(), watch: async callback => { receive = callback; return () => {}; },
      resolve: async () => { receive(); throw Error("Receipt commit unavailable"); } }, () => {});
    await controller.init(); expect(await controller.resolve(retained().operations[0], "discard")).toBe(false);
    expect(controller.view.snapshot?.operations).toHaveLength(1); expect(controller.view.error).toBe("Receipt commit unavailable");
    receive(); await controller.refresh(false); expect(controller.view.error).toBe("Receipt commit unavailable");
    await controller.refresh(); expect(controller.view.error).toBeNull(); controller.dispose();
  });
  it("keeps notification failure visible with usable receipts, and Reload restores event observation", async () => {
    let watches = 0, stops = 0, readCount = 0, receive: () => void = () => {};
    let snapshot = retained();
    const controller = createAiOperationsController({
      read: async () => { readCount++; return snapshot; }, resolve: async () => snapshot,
      watch: async callback => { if (++watches === 1) throw Error("Notifications unavailable; reload"); receive = callback; return () => { stops++; }; },
    }, () => {});
    await controller.init();
    expect(controller.view.snapshot?.operations).toHaveLength(1);
    expect(controller.view.error).toBe("Notifications unavailable; reload");
    await controller.refresh(); expect(controller.view.error).toBeNull(); expect(watches).toBe(2);
    snapshot = { version: 1, operations: [] }; receive(); await controller.refresh();
    expect(controller.view.snapshot?.operations).toEqual([]); expect(readCount).toBeGreaterThan(2);
    controller.dispose(); const before = readCount; receive(); await controller.refresh();
    expect(stops).toBe(1); expect(readCount).toBe(before);
  });
  it("requires exact operation-specific confirmation copy and validates malformed metadata",()=>{
    const row=retained().operations[0];expect(resolutionCopy(row,"discard").body).toContain("operation-1");expect(resolutionCopy(row,"discard").body).toContain("consumer");expect(resolutionCopy(row,"stop").body).toContain("Unknown outcome evidence remains retained");
    expect(validAiOperations(retained())).toBe(true);expect(validAiOperations({...retained(),operations:[{...row,canDiscard:"yes"}]})).toBe(false);
  });
  it("a failed disposition retains the row and a repeated successful action cannot repeat provider work",async()=>{
    let snapshot=retained(),fail=true,calls=0;
    const controller=createAiOperationsController({read:async()=>snapshot,watch:async()=>()=>{},resolve:async(operation,action)=>{calls++;expect(operation.operationId).toBe("operation-1");expect(action).toBe("discard");if(fail)throw Error("Receipt commit unavailable");snapshot={version:1,operations:[]};return snapshot;}},()=>{});
    await controller.init();const row=retained().operations[0];expect(await controller.resolve(row,"discard")).toBe(false);expect(controller.view.snapshot?.operations).toHaveLength(1);expect(controller.view.error).toBe("Receipt commit unavailable");
    fail=false;expect(await controller.resolve(row,"discard")).toBe(true);expect(controller.view.snapshot?.operations).toEqual([]);expect(await controller.resolve(row,"discard")).toBe(false);expect(calls).toBe(2);controller.dispose();
  });
  it("stale pre-action reads cannot restore a discarded row and disposal ignores late responses",async()=>{
    let reads=0;const stale=deferred<AiOperationsSnapshot>(), readStarted=deferred<void>();
    const controller=createAiOperationsController({read:async()=>{ if (++reads === 2) { readStarted.resolve(); return stale.promise; } return reads===1?retained():{version:1,operations:[]}; },watch:async()=>()=>{},resolve:async()=>({version:1,operations:[]})},()=>{});
    await controller.init();const pending=controller.refresh();await readStarted.promise;const action=controller.resolve(retained().operations[0],"discard");
    stale.resolve(retained());await pending;expect(await action).toBe(true);expect(controller.view.snapshot?.operations).toEqual([]);controller.dispose();
    const late=deferred<AiOperationsSnapshot>();let changes=0;const disposed=createAiOperationsController({read:()=>late.promise,watch:async()=>()=>{},resolve:async()=>retained()},()=>changes++);
    const initial=disposed.init();await Promise.resolve();disposed.dispose();const before=changes;late.resolve(retained());await initial;expect(changes).toBe(before);
  });
});
