import {afterEach, describe, expect, it, vi} from "vitest";
const events = vi.hoisted(() => ({handler:null as null | ((event:{payload:{revision:number}})=>void),stop:vi.fn()}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async (_name:string, handler:(event:{payload:{revision:number}})=>void)=>{
  events.handler=handler; return events.stop;
})}));
import {createPluginContext} from "$lib/plugins/api";
import {dialogStore} from "$lib/state/dialogs.svelte";
afterEach(()=>{events.handler=null;events.stop.mockClear();dialogStore.closeSettings();});

describe("host text facade",()=>{
  it("delivers committed revisions and stops after explicit unsubscribe or contribution disposal",async()=>{
    const {ctx,dispose}=createPluginContext("text-consumer");
    const revisions:number[]=[];
    const stop=ctx.text!.subscribe(revision=>revisions.push(revision));
    await Promise.resolve();
    events.handler!({payload:{revision:2}});
    events.handler!({payload:{revision:Number.NaN}});
    expect(revisions).toEqual([2]);
    stop();
    events.handler!({payload:{revision:3}});
    expect(revisions).toEqual([2]);
    dispose();
    ctx.text!.openSettings();
    expect(dialogStore.isSettingsOpen).toBe(false);
  });

  it("opens global Settings for an active text consumer",()=>{
    const {ctx,dispose}=createPluginContext("text-settings-consumer");
    ctx.text!.openSettings();
    expect(dialogStore.isSettingsOpen).toBe(true);
    dispose();
  });
});
