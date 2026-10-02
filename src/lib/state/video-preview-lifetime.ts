/** Two-phase native acquisition: disposal never adopts a late capability. */
import { E2E_HOOKS_ENABLED } from "$lib/api/e2e-hooks";
import type { ForegroundGate } from "./page-foreground";

function trace(stage: string, token: string | null): void {
  if (!E2E_HOOKS_ENABLED || typeof document === "undefined") return;
  const root = document.documentElement;
  const previous = JSON.parse(root.dataset.e2eVideoLifetime ?? "[]") as unknown[];
  root.dataset.e2eVideoLifetime = JSON.stringify([...previous.slice(-19), { stage, token }]);
}
export interface VideoSource {
  readonly url: string;
  release(): void;
}
export interface VideoLoadJob {
  readonly promise: Promise<VideoSource>;
  cancel(): void;
}
export interface VideoTransport {
  begin(): Promise<string>;
  prepare(token: string, path: string): Promise<string>;
  release(token: string): Promise<void>;
}

export function createVideoLoadJob(path: string, transport: VideoTransport, foreground?: ForegroundGate): VideoLoadJob {
  let cancelled = false;
  let token: string | null = null;
  let released = false;
  let cancelWaiting: (() => void) | null = null;
  const release = () => {
    if (released || token === null) return;
    released = true;
    trace("release-request", token);
    void transport.release(token).then(() => trace("release-accepted", token)).catch(error => {
      trace(`release-failed: ${String(error)}`, token);
      console.error("Video preview release failed:", error);
    });
  };
  const promise = (async (): Promise<VideoSource> => {
    if (foreground && !foreground.isForeground) {
      const admitted = await new Promise<boolean>(resolve => {
        const stop = foreground.whenForeground(() => { resolve(true); });
        cancelWaiting = () => { stop(); resolve(false); };
      });
      cancelWaiting = null;
      if (!admitted || cancelled) throw new Error("Video preview was released");
    }
    token = await transport.begin();
    trace("registered", token);
    if (cancelled) {
      release();
      throw new Error("Video preview was released");
    }
    try {
      trace("preparing", token);
      const url = await transport.prepare(token, path);
      trace("prepared", token);
      if (cancelled) throw new Error("Video preview was released");
      return { url, release };
    } catch (error) {
      release();
      throw error;
    }
  })();
  return { promise, cancel() { cancelled = true; cancelWaiting?.(); trace("cancel", token); release(); } };
}
