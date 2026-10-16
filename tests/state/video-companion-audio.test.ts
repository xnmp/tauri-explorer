import { describe, expect, it } from "vitest";
import { followVideo, needsCompanionAudio, type MediaClock } from "$lib/state/video-companion-audio";

class FakeMedia extends EventTarget implements MediaClock {
  currentTime = 0; paused = true; ended = false; volume = 1; muted = false; playbackRate = 1;
  plays = 0;
  async play() { this.plays++; this.paused = false; }
  pause() { this.paused = true; }
  emit(type: string) { this.dispatchEvent(new Event(type)); }
}

function playing(time = 0) {
  const video = new FakeMedia();
  video.currentTime = time;
  video.paused = false;
  return video;
}

describe("needsCompanionAudio (#1171)", () => {
  it("asks for companion audio only when WebKitGTK reports no audio track", () => {
    expect(needsCompanionAudio({ audioTracks: { length: 0 } }, "linux")).toBe(true);
    expect(needsCompanionAudio({ audioTracks: { length: 1 } }, "linux")).toBe(false);
  });
  it("leaves engines without track reporting, and Windows/macOS, unchanged", () => {
    expect(needsCompanionAudio({}, "linux")).toBe(false);
    expect(needsCompanionAudio({ audioTracks: { length: 0 } }, "windows")).toBe(false);
    expect(needsCompanionAudio({ audioTracks: { length: 0 } }, "macos")).toBe(false);
  });
});

describe("followVideo (#1171)", () => {
  it("starts with an already-playing video at its current time and level", () => {
    const video = playing(12.5);
    video.volume = 0.4; video.muted = true; video.playbackRate = 1.5;
    const audio = new FakeMedia();
    followVideo(video, audio);
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(12.5);
    expect([audio.volume, audio.muted, audio.playbackRate]).toEqual([0.4, true, 1.5]);
  });

  it("follows play and pause, and stays silent while the video is paused", () => {
    const video = new FakeMedia();
    const audio = new FakeMedia();
    followVideo(video, audio);
    expect(audio.paused).toBe(true);
    video.paused = false; video.currentTime = 3; video.emit("play");
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(3);
    video.paused = true; video.emit("pause");
    expect(audio.paused).toBe(true);
  });

  it("volume and mute controls change the companion audio", () => {
    const video = playing();
    const audio = new FakeMedia();
    followVideo(video, audio);
    video.volume = 0.25; video.emit("volumechange");
    expect(audio.volume).toBe(0.25);
    video.muted = true; video.emit("volumechange");
    expect(audio.muted).toBe(true);
    video.muted = false; video.emit("volumechange");
    expect(audio.muted).toBe(false);
  });

  it("holds during seeks and buffering, then resumes at the video's position", () => {
    const video = playing(1);
    const audio = new FakeMedia();
    followVideo(video, audio);
    video.emit("seeking");
    expect(audio.paused).toBe(true);
    video.currentTime = 40; video.emit("seeked");
    expect(audio.currentTime).toBe(40);
    expect(audio.paused).toBe(false);
    video.emit("waiting");
    expect(audio.paused).toBe(true);
    video.emit("playing");
    expect(audio.paused).toBe(false);
  });

  it("a seek while paused moves the audio without starting it", () => {
    const video = new FakeMedia();
    const audio = new FakeMedia();
    followVideo(video, audio);
    video.currentTime = 9; video.emit("seeked");
    expect(audio.currentTime).toBe(9);
    expect(audio.paused).toBe(true);
  });

  it("corrects audible drift but tolerates small jitter", () => {
    const video = playing(10);
    const audio = new FakeMedia();
    followVideo(video, audio);
    audio.currentTime = 10.1; video.emit("timeupdate");
    expect(audio.currentTime).toBe(10.1);
    video.currentTime = 11; audio.currentTime = 10.2; video.emit("timeupdate");
    expect(audio.currentTime).toBe(11);
  });

  it("stops at the end and detaching silences it and ignores later events", () => {
    const video = playing();
    const audio = new FakeMedia();
    const detach = followVideo(video, audio);
    video.ended = true; video.emit("ended");
    expect(audio.paused).toBe(true);
    video.ended = false;
    detach();
    expect(audio.paused).toBe(true);
    video.emit("play");
    video.volume = 0.1; video.emit("volumechange");
    expect(audio.paused).toBe(true);
    expect(audio.volume).toBe(1);
  });
});
