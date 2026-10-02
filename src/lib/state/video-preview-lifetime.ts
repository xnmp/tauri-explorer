/** Two-phase native acquisition: disposal never adopts a late capability. */
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

export function createVideoLoadJob(path: string, transport: VideoTransport): VideoLoadJob {
  let cancelled = false;
  let token: string | null = null;
  let released = false;
  const release = () => {
    if (released || token === null) return;
    released = true;
    void transport.release(token).catch(error => console.error("Video preview release failed:", error));
  };
  const promise = (async (): Promise<VideoSource> => {
    token = await transport.begin();
    if (cancelled) {
      release();
      throw new Error("Video preview was released");
    }
    try {
      const url = await transport.prepare(token, path);
      if (cancelled) throw new Error("Video preview was released");
      return { url, release };
    } catch (error) {
      release();
      throw error;
    }
  })();
  return { promise, cancel() { cancelled = true; release(); } };
}
