import { describe, expect, it } from "vitest";
import {
  audibleVolume, DEFAULT_UNMUTE_VOLUME, rememberAudible, setVolumeTo, stepVolume, toggleMuted,
  volumeLevel, volumeText, wheelVolumeDelta, type VolumeState,
} from "$lib/domain/video-preview";

const sound = (volume: number, muted = false): VolumeState => ({ volume, muted });

describe("video volume control (#1425)", () => {
  it("mutes an audible player without losing its volume, and unmuting restores it", () => {
    const muted = toggleMuted(sound(0.7), 0.7);
    expect(muted).toEqual(sound(0.7, true));
    expect(audibleVolume(muted)).toBe(0);
    expect(toggleMuted(muted, 0.7)).toEqual(sound(0.7));
  });

  it("unmuting a player at zero restores the last audible volume", () => {
    let last = 1;
    let state = sound(0.4);
    last = rememberAudible(last, state);
    state = setVolumeTo(state, 0);
    last = rememberAudible(last, state);
    expect(volumeLevel(state)).toBe("muted");
    expect(toggleMuted(state, last)).toEqual(sound(0.4));
    // Muted at zero (dragged to zero after muting) also comes back audible.
    expect(toggleMuted(sound(0, true), last)).toEqual(sound(0.4));
  });

  it("unmuting at zero with no audible history uses a sensible default", () => {
    for (const last of [0, NaN, -1]) expect(toggleMuted(sound(0, true), last)).toEqual(sound(DEFAULT_UNMUTE_VOLUME));
    expect(DEFAULT_UNMUTE_VOLUME).toBeGreaterThan(0);
  });

  it("classifies the speaker icon by what is heard", () => {
    expect([sound(0), sound(0.8, true), sound(0.01), sound(0.49), sound(0.5), sound(1)].map(volumeLevel))
      .toEqual(["muted", "muted", "low", "low", "high", "high"]);
    expect([sound(NaN), sound(-0.2), sound(3)].map(volumeLevel)).toEqual(["muted", "muted", "high"]);
  });

  it("describes the slider value for assistive technology", () => {
    expect([sound(0.25), sound(0.25, true), sound(0), sound(1), sound(0.333)].map(volumeText))
      .toEqual(["25%", "Muted", "Muted", "100%", "33%"]);
  });

  it("only remembers audible volumes", () => {
    expect(rememberAudible(0.6, sound(0.3))).toBe(0.3);
    expect(rememberAudible(0.6, sound(0.3, true))).toBe(0.6);
    expect(rememberAudible(0.6, sound(0))).toBe(0.6);
  });

  it("clamps set and stepped volumes, unmuting only for audible values", () => {
    expect(setVolumeTo(sound(0.5, true), 0.25)).toEqual(sound(0.25));
    expect(setVolumeTo(sound(0.5, true), 0)).toEqual(sound(0, true));
    expect(setVolumeTo(sound(0.5), 7)).toEqual(sound(1));
    expect(setVolumeTo(sound(0.5), NaN)).toEqual(sound(0));
    expect(stepVolume(sound(0.98), 0.05)).toEqual(sound(1));
    expect(stepVolume(sound(0.02), -0.05)).toEqual(sound(0));
    expect(stepVolume(sound(0.6, true), 0.05).muted).toBe(false);
    expect(stepVolume(sound(0.6, true), 0.05).volume).toBeCloseTo(0.65);
  });

  it("maps wheel direction to one step, ignoring horizontal or invalid deltas", () => {
    expect([-120, -1, 1, 300, 0, NaN, Infinity].map(wheelVolumeDelta)).toEqual([0.05, 0.05, -0.05, -0.05, 0, 0, 0]);
  });
});
