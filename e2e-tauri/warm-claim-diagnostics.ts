/** Process-only evidence for a lost WebDriver session during warm-claim expiry (#781). */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  firstMissingRendererAt,
  type NativeProcessSample,
  type ProcessObservation,
} from "./fresh-window-diagnostics";

export interface WarmClaimIdentity {
  sourceHandle: string;
  survivorHandle: string;
  parkedHandle: string;
  parkedLabel: string;
}

export type WarmClaimStage =
  | "source-close-requested"
  | "source-close-command-settled"
  | "survivor-selected"
  | "source-handle-gone"
  | "parked-handle-gone";

export interface WarmClaimMilestone {
  stage: "monitor-started" | WarmClaimStage;
  at: number;
}

export interface WarmClaimFailureDiagnostics extends WarmClaimIdentity {
  issue: 781;
  phase: "claim-expiry-failed";
  startedAt: number;
  failedAt: number;
  failure: string;
  milestones: readonly WarmClaimMilestone[];
  nativeBeforeClose: NativeProcessSample;
  nativeDuringExpiry: readonly NativeProcessSample[];
  /** All renderer identities visible before source close; no WebView attribution is assumed. */
  rendererDisappearances: readonly {
    renderer: ProcessObservation;
    firstMissingAt: number | null;
  }[];
}

export function rendererDisappearances(
  before: NativeProcessSample,
  during: readonly NativeProcessSample[],
): WarmClaimFailureDiagnostics["rendererDisappearances"] {
  if (!("webkit" in before)) return [];
  return before.webkit
    .filter(({ executable, startTime }) =>
      executable !== null && path.basename(executable) === "WebKitWebProcess" &&
      startTime !== null)
    .map((renderer) => ({
      renderer,
      firstMissingAt: firstMissingRendererAt(renderer, during),
    }));
}

/** Hash the untrusted label; keep it verbatim only inside the JSON artifact. */
export function warmClaimFailureFileName(record: WarmClaimFailureDiagnostics): string {
  const digest = createHash("sha256").update(record.parkedLabel).digest("hex").slice(0, 12);
  return `${record.startedAt}-${digest}-warm-claim-failed.json`;
}

/** A failed diagnostic write must never replace the original WebDriver error. */
export function writeWarmClaimFailure(
  record: WarmClaimFailureDiagnostics,
  directory: string,
): string | null {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, warmClaimFailureFileName(record));
    fs.writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`);
    return destination;
  } catch {
    return null;
  }
}
