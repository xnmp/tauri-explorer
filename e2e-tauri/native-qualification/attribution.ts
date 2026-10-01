import fs from "node:fs";
import { resolveQualificationArtifactPath } from "./artifacts";
import { parseAttributedMacStartupLog } from "./readiness";
import { assessRendererLoss, MacRendererLossError, MAX_RECOVERED_RENDERER_LOSSES } from "./renderer-loss";
import { compactSummary, summarizeDurations } from "./stats";
import type { CompactDurationSummary } from "./stats";
import type {
  AttributedMacStartupMeasurement,
  HalfBounceQualification,
  InteractiveMacStartupEvidence,
  MacStartupPhases,
  MacStartupQualificationReportInput,
  RendererLossRecord,
  VerifiedNativeBuild,
} from "./types";

/**
 * Resolve an evidence-supplied path inside the retained qualification root.
 * Symlinks are followed first, so a link inside the root cannot smuggle in a
 * reference to a recording or trace that the run does not retain.
 */
function resolveEvidencePath(
  realRoot: string,
  candidate: unknown,
  label: string,
): string {
  if (typeof candidate !== "string" || candidate.trim() === "") {
    throw new Error(`interactive evidence requires a ${label} path`);
  }
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new Error(`interactive evidence ${label} does not exist: ${candidate}`);
  }
  return resolveQualificationArtifactPath(realRoot, real);
}

function requiredCondition(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`interactive evidence requires a non-empty ${field}`);
  }
  return value;
}

function requiredOutcomeMs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`interactive evidence ${label} must be a non-negative number`);
  }
  return value;
}

/** Load externally captured, same-run interactive evidence without trusting paths or provenance. */
export function loadInteractiveMacStartupEvidence(
  evidencePath: string,
  qualificationRoot: string,
  build: VerifiedNativeBuild,
  hardwareModel: string,
  requestedSamples: number,
): InteractiveMacStartupEvidence {
  const realRoot = fs.realpathSync(qualificationRoot);
  const safeEvidencePath = resolveEvidencePath(realRoot, evidencePath, "evidence file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(safeEvidencePath, "utf8"));
  } catch {
    throw new Error(`interactive evidence is not valid JSON: ${safeEvidencePath}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("interactive evidence must be a JSON object");
  }
  const evidence = parsed as Partial<InteractiveMacStartupEvidence>;
  if (evidence.buildSha256 !== build.binarySha256) {
    throw new Error("interactive evidence build SHA-256 does not match the verified binary");
  }
  if (evidence.hardwareModel !== hardwareModel) {
    throw new Error("interactive evidence hardware model does not match this Mac");
  }
  if (evidence.launchMethod !== "launch-services-normal-application-launch") {
    throw new Error("interactive evidence must use the normal Launch Services application path");
  }
  const cachePolicy = requiredCondition(evidence.cachePolicy, "cachePolicy");
  const focus = requiredCondition(evidence.focus, "focus");
  const visibility = requiredCondition(evidence.visibility, "visibility");
  const halfBounceDeadlineMs = evidence.halfBounceDeadlineMs;
  if (
    typeof halfBounceDeadlineMs !== "number" ||
    !Number.isFinite(halfBounceDeadlineMs) ||
    halfBounceDeadlineMs <= 0
  ) {
    throw new Error("interactive evidence requires a positive measured half-bounce deadline");
  }
  if (
    !Array.isArray(evidence.samples) ||
    evidence.samples.length !== requestedSamples
  ) {
    throw new Error(`interactive evidence requires exactly ${requestedSamples} samples`);
  }
  const samples = evidence.samples.map((sample, index) => {
    if (typeof sample !== "object" || sample === null) {
      throw new Error(`interactive evidence sample ${index + 1} is not an object`);
    }
    const position = `sample ${index + 1}`;
    const resolveArtifact = (candidate: unknown, label: string): string => {
      const resolved = resolveEvidencePath(realRoot, candidate, `${position} ${label}`);
      if (!fs.statSync(resolved).isFile()) {
        throw new Error(`interactive evidence ${position} ${label} is not a file: ${resolved}`);
      }
      return resolved;
    };
    return {
      firstFunctionalFrameMs: requiredOutcomeMs(
        sample.firstFunctionalFrameMs,
        `${position} firstFunctionalFrameMs`,
      ),
      inputReadyMs: requiredOutcomeMs(sample.inputReadyMs, `${position} inputReadyMs`),
      log: resolveArtifact(sample.log, "startup log"),
      launchRecording: resolveArtifact(sample.launchRecording, "launch recording"),
      nativeTrace: resolveArtifact(sample.nativeTrace, "native trace"),
    };
  });
  return {
    buildSha256: build.binarySha256,
    hardwareModel,
    launchMethod: "launch-services-normal-application-launch",
    cachePolicy,
    focus,
    visibility,
    halfBounceDeadlineMs,
    samples,
  };
}

export function buildInteractiveMacStartupQualificationReport(input: {
  evidencePath: string;
  qualificationRoot: string;
  build: VerifiedNativeBuild;
  platform: MacStartupQualificationReportInput["platform"];
  requestedSamples: number;
  timeoutMs: number;
  startedAt: string;
  finishedAt: string;
}) {
  const evidence = loadInteractiveMacStartupEvidence(
    input.evidencePath,
    input.qualificationRoot,
    input.build,
    input.platform.hardwareModel,
    input.requestedSamples,
  );
  // A recorded launch cannot be replaced, so a renderer loss in one fails the
  // report (with the loss recorded) instead of aborting it (#942).
  const errors: string[] = [];
  const rendererLosses: RendererLossRecord[] = [];
  const samples = evidence.samples.flatMap((sample, index) => {
    const log = fs.readFileSync(sample.log, "utf8");
    const loss = assessRendererLoss(log);
    if (loss.status !== "none") {
      const failure = loss.status === "failed" ? loss.reason : loss.status === "pending" ? "no recovery recorded" : null;
      const description = new MacRendererLossError(loss.terminations, log, failure).message;
      rendererLosses.push({ sample: index + 1, recovered: failure === null, description, log: sample.log, evidence: null });
      // The report fails an unrecovered loss itself; a recovered one is still not a measurement.
      if (failure === null) errors.push(`sample ${index + 1}: a recorded launch lost its renderer and cannot be replaced`);
      return [];
    }
    return [{
      ...parseAttributedMacStartupLog(log, {
        firstFunctionalFrame: "observed",
        firstFunctionalFrameMs: sample.firstFunctionalFrameMs,
        inputOutcome: "verified",
        inputReadyMs: sample.inputReadyMs,
        measureWarm: false,
      }),
      log: sample.log,
    }];
  });
  const artifacts = evidence.samples.flatMap((sample) => [
    sample.log,
    sample.launchRecording,
    sample.nativeTrace,
  ]);
  return buildMacStartupQualificationReport({
    build: input.build,
    platform: input.platform,
    scenario: {
      id: "macos-interactive-startup",
      requestedSamples: input.requestedSamples,
      timeoutMs: input.timeoutMs,
      warmMeasure: false,
      launchMethod: evidence.launchMethod,
      cachePolicy: evidence.cachePolicy,
      focus: evidence.focus,
      visibility: evidence.visibility,
      frameCriterion:
        "externally timed first presented functional frame with per-sample launch recording",
      inputCriterion:
        "externally timed successful real-input outcome with per-sample native trace",
    },
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    samples,
    artifacts,
    errors,
    rendererLosses,
    halfBounceDeadlineMs: evidence.halfBounceDeadlineMs,
  });
}

export function buildMacStartupQualificationReport(
  input: MacStartupQualificationReportInput,
) {
  const samples = [...input.samples];
  const rendererLosses = [...(input.rendererLosses ?? [])];
  const errors = [
    ...input.errors,
    ...rendererLosses.filter(({ recovered }) => !recovered)
      .map(({ sample, description }) => `sample ${sample}: ${description}`),
  ];
  const recovered = rendererLosses.filter(({ recovered }) => recovered).length;
  if (recovered > MAX_RECOVERED_RENDERER_LOSSES) {
    errors.push(`renderer lost in ${recovered} recovered samples (limit ${MAX_RECOVERED_RENDERER_LOSSES})`);
  }
  const halfBounce = qualifyHalfBounce(samples, input.halfBounceDeadlineMs);
  // An explicitly measured deadline that the evidence misses is a failed run,
  // not a green one with a footnote. `unqualified` (no deadline, or incomplete
  // interactive evidence) stays non-fatal: it claims nothing either way.
  if (halfBounce.status === "missed") errors.push(halfBounce.reason);
  return {
    schemaVersion: 2 as const,
    build: input.build,
    platform: input.platform,
    scenario: input.scenario,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    coldStartup: summarizeDurations(samples.map(({ coldTotalMs }) => coldTotalMs)),
    warmActivation: summarizeDurations(
      samples.flatMap(({ warmShowMs }) =>
        warmShowMs === null ? [] : [warmShowMs],
      ),
    ),
    phaseAttribution: summarizeMacStartupPhases(samples),
    halfBounce,
    samples,
    rendererLosses,
    artifacts: [...input.artifacts],
    failureArtifacts: errors.length > 0 ? [...input.artifacts] : [],
    errors,
    passed: errors.length === 0 && samples.length === input.scenario.requestedSamples,
  };
}

export function summarizeMacStartupPhases(
  samples: readonly AttributedMacStartupMeasurement[],
): Record<
  keyof MacStartupPhases | "readinessTotalMs" | "launchTotalMs",
  CompactDurationSummary
> {
  const phase = (key: keyof MacStartupPhases): number[] =>
    samples.map((sample) => sample.phases[key]);
  return {
    readinessTotalMs: compactSummary(samples.map((sample) => sample.readinessTotalMs)),
    launchTotalMs: compactSummary(samples.map((sample) => sample.launchTotalMs)),
    processEntryMs: compactSummary(phase("processEntryMs")),
    nativeWindowMs: compactSummary(phase("nativeWindowMs")),
    frameworkNavigationMs: compactSummary(phase("frameworkNavigationMs")),
    documentBootMs: compactSummary(phase("documentBootMs")),
    requiredAppWorkMs: compactSummary(phase("requiredAppWorkMs")),
    frameSchedulingMs: compactSummary(phase("frameSchedulingMs")),
    readinessIpcMs: compactSummary(phase("readinessIpcMs")),
    unattributedMs: compactSummary(phase("unattributedMs")),
  };
}

export function qualifyHalfBounce(
  samples: readonly AttributedMacStartupMeasurement[],
  deadlineMs: number | null,
): HalfBounceQualification {
  if (deadlineMs === null) {
    return {
      status: "unqualified",
      deadlineMs,
      reason: "no measured half-bounce deadline was supplied",
    };
  }
  if (
    samples.length === 0 ||
    samples.some(
      (sample) =>
        sample.firstFunctionalFrame !== "observed" ||
        sample.firstFunctionalFrameMs === null ||
        sample.inputOutcome !== "verified" ||
        sample.inputReadyMs === null,
    )
  ) {
    return {
      status: "unqualified",
      deadlineMs,
      reason: "visible functional-frame and verified-input evidence is incomplete",
    };
  }
  const p95 = summarizeDurations(
    samples.map((sample) =>
      Math.max(sample.firstFunctionalFrameMs!, sample.inputReadyMs!),
    ),
  ).p95Ms!;
  return p95 <= deadlineMs
    ? {
        status: "qualified",
        deadlineMs,
        reason: `visible-and-input-functional p95 ${p95.toFixed(1)}ms met the measured ${deadlineMs.toFixed(1)}ms deadline`,
      }
    : {
        status: "missed",
        deadlineMs,
        reason: `visible-and-input-functional p95 ${p95.toFixed(1)}ms exceeded the measured ${deadlineMs.toFixed(1)}ms deadline`,
      };
}
