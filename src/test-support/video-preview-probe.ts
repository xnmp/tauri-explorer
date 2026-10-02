/** Observe real native streaming; never substitute media state or bytes. */
import { invoke } from "$lib/api/common";
import { createDomRpc } from "./dom-rpc";

export function startVideoPreviewProbe(signal: AbortSignal): void {
  createDomRpc<{ token: string; op: "stats" }>({
    event: "e2e-video-operation",
    resultKey: "e2eVideoResult",
    readyKey: "e2eVideoReady",
    signal,
    handlers: { stats: () => invoke("e2e_video_preview_stats") },
  });
}
