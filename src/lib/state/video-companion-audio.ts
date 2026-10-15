/**
 * Companion audio for videos whose audio track the WebView dropped (#1171).
 *
 * WebKitGTK plays a video's picture but silently omits an audio stream with no
 * installed GStreamer decoder (AAC without gst-libav): no media error, and
 * `audioTracks` stays empty. The backend then decodes that stream with ffmpeg
 * and this module keeps a hidden `<audio>` element following the video's
 * clock, volume and mute, so the existing controls drive what is heard.
 */

/** The subset of HTMLMediaElement the follower reads and drives. */
export interface MediaClock extends EventTarget {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  play(): Promise<void>;
  pause(): void;
}

/** Larger drifts are corrected by seeking the audio; smaller ones are inaudible. */
export const MAX_AUDIO_DRIFT_SECONDS = 0.25;

/**
 * Only WebKitGTK (Linux) needs the fallback. Engines without the
 * `audioTracks` API (Chromium/WebView2) cannot report a dropped track, and
 * WKWebView/WebView2 decode common audio natively, so they are left unchanged.
 */
export function needsCompanionAudio(video: object, platform: "linux" | "windows" | "macos"): boolean {
  // TypeScript's DOM library omits the WebKit-only `audioTracks` list.
  const tracks = (video as { audioTracks?: { length: number } }).audioTracks;
  return platform === "linux" && tracks !== undefined && tracks.length === 0;
}

/** Makes `audio` follow `video`; returns a detach function that pauses it. */
export function followVideo(video: MediaClock, audio: MediaClock): () => void {
  const align = () => {
    if (Math.abs(audio.currentTime - video.currentTime) > MAX_AUDIO_DRIFT_SECONDS) audio.currentTime = video.currentTime;
  };
  const resume = () => {
    if (video.paused || video.ended) return;
    align();
    if (audio.paused) audio.play().catch(() => { /* a later play/seek retries */ });
  };
  const hold = () => { audio.pause(); };
  const level = () => {
    audio.volume = video.volume;
    audio.muted = video.muted;
    audio.playbackRate = video.playbackRate;
  };
  const tick = () => { if (!video.paused && !audio.paused) align(); };
  const seeked = () => {
    audio.currentTime = video.currentTime;
    resume();
  };
  const listeners: [string, () => void][] = [
    ["play", resume], ["playing", resume], ["seeked", seeked], ["timeupdate", tick],
    ["pause", hold], ["waiting", hold], ["seeking", hold], ["ended", hold],
    ["volumechange", level], ["ratechange", level],
  ];
  for (const [type, listener] of listeners) video.addEventListener(type, listener);
  level();
  audio.currentTime = video.currentTime;
  resume();
  return () => {
    for (const [type, listener] of listeners) video.removeEventListener(type, listener);
    audio.pause();
  };
}
