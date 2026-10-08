import { invoke, virtualPathGuard } from "./common";
import { getNativeResourceSession } from "./native-resource-session";
import { createVideoLoadJob, type VideoLoadJob } from "$lib/state/video-preview-lifetime";
import { pageForeground } from "$lib/state/page-foreground";

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
