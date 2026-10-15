import { invoke, virtualPathGuard } from "./common";
import { getNativeResourceSession } from "./native-resource-session";
import { createVideoLoadJob, type VideoLoadJob } from "$lib/state/video-preview-lifetime";
import { pageForeground } from "$lib/state/page-foreground";
import type { VideoCodecInfo } from "$lib/domain/video-preview";

export function loadVideoPreview(path: string): VideoLoadJob {
  const guard = virtualPathGuard(path);
  return createVideoLoadJob(path, {
    async begin() {
      if (guard) throw new Error(guard.error);
      return invoke<string>("begin_video_preview", { sessionId: await getNativeResourceSession() });
    },
    async prepare(token, path) {
      return invoke<string>("prepare_video_preview", { sessionId: await getNativeResourceSession(), token, path });
    },
    async release(token) {
      await invoke("release_video_preview", { sessionId: await getNativeResourceSession(), token });
    },
  }, pageForeground);
}

/** Thrown by {@link loadVideoAudio} when the file has no audio stream. */
export class NoVideoAudio extends Error {
  constructor() { super("This video has no audio track"); }
}

/**
 * Companion audio decoded by the backend for a video whose own audio track
 * the WebView dropped (#1171). Shares the video capability lifecycle.
 */
export function loadVideoAudio(path: string): VideoLoadJob {
  const guard = virtualPathGuard(path);
  return createVideoLoadJob(path, {
    async begin() {
      if (guard) throw new Error(guard.error);
      return invoke<string>("begin_video_preview", { sessionId: await getNativeResourceSession() });
    },
    async prepare(token, path) {
      const url = await invoke<string | null>("prepare_video_audio_preview", { sessionId: await getNativeResourceSession(), token, path });
      if (url === null) throw new NoVideoAudio();
      return url;
    },
    async release(token) {
      await invoke("release_video_preview", { sessionId: await getNativeResourceSession(), token });
    },
  }, pageForeground);
}

export async function probeVideoCodec(path: string): Promise<VideoCodecInfo | null> {
  try { return await invoke<VideoCodecInfo>("probe_video_codec", { path }); } catch { return null; }
}

/** Asks for a destination, then copies; resolves false when the user cancels. */
export async function saveVideoCopy(path: string, name: string): Promise<boolean> {
  const destination = await invoke<string | null>("pick_file", { options: { mode: "save", title: "Save a copy of video", filename: name } });
  if (!destination) return false;
  await invoke<void>("save_file_copy", { source: path, destination });
  return true;
}
