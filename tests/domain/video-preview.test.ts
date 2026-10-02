import { describe,expect,it } from "vitest";
import { mediaTime,seekTime,videoKeyAction } from "$lib/domain/video-preview";
const key = (value:string,modifiers={}) => ({key:value,ctrlKey:false,altKey:false,metaKey:false,...modifiers});
describe("video playback input",()=>{
  it("formats finite elapsed values and clamps invalid seek targets",()=>{
    expect([0,61,3661,NaN,-1,Infinity].map(mediaTime)).toEqual(["0:00","1:01","1:01:01","0:00","0:00","0:00"]);
    expect([seekTime(-10,6),seekTime(99,6),seekTime(5,NaN),seekTime(NaN,6)]).toEqual([0,6,0,0]);
  });
  it("routes media shortcuts only on eligible surfaces",()=>{
    expect(videoKeyAction(key("ArrowRight"),"surface")).toBe("seek-forward");
    expect(videoKeyAction(key("M"),"surface")).toBe("mute");
    expect(videoKeyAction(key(" "),"surface")).toBe("toggle-play");
    for(const control of ["button","range"] as const) expect(videoKeyAction(key(" "),control)).toBeNull();
    expect(videoKeyAction(key("ArrowRight"),"range")).toBeNull();
    expect(videoKeyAction(key("f",{ctrlKey:true}),"surface")).toBeNull();
    expect(videoKeyAction(key("Escape"),"surface")).toBeNull();
    for (const value of ["m","f"," "]) {
      expect(videoKeyAction(key(value),"surface",true)).toBeNull();
      expect(videoKeyAction(key(value,{repeat:true}),"surface")).toBe("consume");
    }
    expect(videoKeyAction(key("ArrowRight",{repeat:true}),"surface")).toBe("seek-forward");
  });
});
