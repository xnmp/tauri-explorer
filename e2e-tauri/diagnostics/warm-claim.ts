/**
 * Process-only evidence for a lost WebDriver session during abandoned
 * warm-claim expiry.
 *
 * Retire-when: #781 closed
 *
 * See `docs/lessons/781-fresh-window-selection-diagnostics.md`. The samples
 * do not establish which WebView owned a renderer; compare a failing artifact
 * with `e2e-tauri/logs/tauri-driver.log` before attributing cause.
 */
import { diagnosticsDirectory, hashedArtifactName, writeDiagnosticArtifact } from "./artifact";
import {
  startProcessTimeline,
  type NativeProcessSample,
  type ProcessObservation,
  type ProcessSampler,
  type RendererLifetime,
} from "./process-timeline";

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

interface WarmClaimMilestone {
  stage: "monitor-started" | WarmClaimStage;
  at: number;
}

interface WarmClaimFailure extends WarmClaimIdentity {
  issue: 781;
  phase: "claim-expiry-failed";
  startedAt: number;
  failedAt: number;
  failure: string;
  milestones: readonly WarmClaimMilestone[];
  nativeBeforeClose: NativeProcessSample;
  nativeDuringExpiry: readonly NativeProcessSample[];
  /** All renderer identities visible before source close; no WebView attribution is assumed. */
  rendererDisappearances: readonly { renderer: ProcessObservation; firstMissingAt: number | null }[];
  /** Records later renderer births and deaths even if their raw samples rolled out. */
  observedRendererLifetimes: readonly RendererLifetime[];
  untrackedRendererObservations: number;
}

/**
 * Sample every WebKit renderer identity before the source window closes and
 * throughout abandoned warm-claim expiry. On failure, write one artifact from
 * local process state only, then rethrow the original error.
 */
export async function monitorWarmClaimExpiry<T>(
  claim: WarmClaimIdentity,
  action: (mark: (stage: WarmClaimStage) => void) => Promise<T>,
  options: { collect?: ProcessSampler; directory?: string } = {},
): Promise<T> {
  const startedAt = Date.now();
  const milestones: WarmClaimMilestone[] = [{ stage: "monitor-started", at: startedAt }];
  const mark = (stage: WarmClaimStage) => milestones.push({ stage, at: Date.now() });
  // The source-window wait is 10 s and the parked-window wait is 40 s.
  const timeline = startProcessTimeline({ timeout: 50_000, collect: options.collect });
  try {
    return await action(mark);
  } catch (error) {
    timeline.sample();
    const record: WarmClaimFailure = {
      issue: 781,
      phase: "claim-expiry-failed",
      ...claim,
      startedAt,
      failedAt: Date.now(),
      failure: String(error),
      milestones,
      nativeBeforeClose: timeline.samples[0],
      nativeDuringExpiry: timeline.samples,
      rendererDisappearances: timeline.baselineRendererDisappearances(),
      observedRendererLifetimes: timeline.observedRendererLifetimes(),
      untrackedRendererObservations: timeline.untrackedRendererObservations(),
    };
    writeDiagnosticArtifact(
      options.directory ?? diagnosticsDirectory("warm-claim"),
      hashedArtifactName(startedAt, claim.parkedLabel, "warm-claim-failed"),
      record,
    );
    throw error;
  } finally {
    timeline.stop();
  }
}
