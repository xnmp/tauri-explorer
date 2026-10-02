import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";

export interface NativeDriverTranscript {
  finish: () => Promise<void>;
}

/** ADR 0021: stdio drain and final evidence writes have their own cleanup bound. */
export function captureNativeDriverTranscript(
  child: ChildProcess,
  log: Writable,
  timeoutMs = 5_000,
): NativeDriverTranscript {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("driver transcript timeout must be positive and finite");
  }
  const onClose = () => log.end();
  const detach = () => {
    child.removeListener("close", onClose);
    child.stdout?.unpipe(log);
    child.stderr?.unpipe(log);
  };
  // Observe errors immediately, even when spawn/session admission fails before
  // cleanup awaits this owner. Rejection is deferred to finish(), not dropped.
  const completion = finished(log, { cleanup: true }).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  // `close` follows stdio drain, including failed spawn with no `exit`.
  child.once("close", onClose);

  return {
    finish: () => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = new Error(`native driver transcript did not finish within ${timeoutMs}ms`);
        detach();
        // finish() follows owned-process termination. Release pipe handles too
        // if an inherited descriptor prevents stdio from ever announcing EOF.
        child.stdout?.destroy();
        child.stderr?.destroy();
        log.destroy(error);
        reject(error);
      }, timeoutMs);
      completion.then((result) => {
        clearTimeout(timeout);
        detach();
        if (result.ok) resolve();
        else reject(result.error);
      });
    }),
  };
}
