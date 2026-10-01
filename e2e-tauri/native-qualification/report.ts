import { nearestRank } from "./stats";
import { SOAK_SCENARIOS } from "./types";
import type {
  NativeQualificationReport,
  NativeQualificationReportInput,
  ResourceMeasurement,
} from "./types";

// Compare settled process-tree RSS, not the first cold-start sample or a
// transient peak while a new WebView is being constructed.
const MAX_LATE_RSS_GROWTH_BYTES = 1024 * 1024 * 1024;
export const MAX_WEBKIT_SHARED_MEMORY_FD_GROWTH = 16;

// During a run, compare settled sample windows so one teardown spike neither
// masks a leak nor fails an otherwise healthy session.
export function rollingWebKitSharedMemoryFdGrowth(samples: readonly ResourceMeasurement[]): number | null {
  const counts = samples.map(({ webKitSharedMemoryFds }) => webKitSharedMemoryFds)
    .filter((count): count is number => count !== undefined && Number.isFinite(count));
  const window = Math.max(5, Math.floor(counts.length / 10));
  if (counts.length < window * 3) return null;
  const early = nearestRank(counts.slice(window, window * 2), 0.5);
  const late = nearestRank(counts.slice(-window), 0.5);
  return early === null || late === null ? null : late - early;
}

function lateQuarterGrowth(
  samples: readonly ResourceMeasurement[],
  durationMs: number,
  value: (sample: ResourceMeasurement) => number | undefined,
): number | null {
  const numbers = (subset: readonly ResourceMeasurement[]) => subset.map(value)
    .filter((entry): entry is number => entry !== undefined && Number.isFinite(entry));
  const early = numbers(samples.filter(({ sampledAtMs }) => sampledAtMs <= durationMs / 4));
  const late = numbers(samples.filter(({ sampledAtMs }) => sampledAtMs >= durationMs * 3 / 4));
  if (early.length < 5 || late.length < 5) return null;
  const earlyMedian = nearestRank(early, 0.5);
  const lateMedian = nearestRank(late, 0.5);
  return earlyMedian === null || lateMedian === null ? null : lateMedian - earlyMedian;
}

function lateRssGrowth(samples: readonly ResourceMeasurement[], durationMs: number): number | null {
  if (samples.length < 40) return null;
  return lateQuarterGrowth(samples, durationMs, ({ rssBytes }) => rssBytes);
}

export function buildNativeQualificationReport(
  input: NativeQualificationReportInput,
): NativeQualificationReport {
  if (!input.configuration.seed || input.configuration.durationMs <= 0) {
    throw new Error(
      "native qualification requires a seed and a positive duration",
    );
  }
  const durations = input.scenarios.map(({ durationMs }) => durationMs);
  const runErrors = [...(input.runErrors ?? [])];
  const fullSoak = input.configuration.maxCycles === undefined &&
    input.configuration.durationMs >= 14_400_000;
  const growth = lateRssGrowth(input.resources, input.configuration.durationMs);
  const webKitFdCounts = input.resources.map(({ webKitSharedMemoryFds }) => webKitSharedMemoryFds)
    .filter((count): count is number => count !== undefined && Number.isFinite(count));
  const webKitFdGrowth = lateQuarterGrowth(
    input.resources, input.configuration.durationMs,
    ({ webKitSharedMemoryFds }) => webKitSharedMemoryFds,
  );
  if (fullSoak) {
    if (input.configuration.scenarios.length !== SOAK_SCENARIOS.length ||
        SOAK_SCENARIOS.some((scenario) => !input.configuration.scenarios.includes(scenario))) {
      runErrors.push("full native soak must execute every qualification scenario");
    }
    const elapsed = Date.parse(input.finishedAt) - Date.parse(input.startedAt);
    if (!Number.isFinite(elapsed) || elapsed < input.configuration.durationMs) {
      runErrors.push(`native soak ended before ${input.configuration.durationMs} ms elapsed`);
    }
    const timestampsValid = input.resources.every(({ sampledAtMs }, index) =>
      Number.isFinite(sampledAtMs) && sampledAtMs >= 0 &&
      (index === 0 || sampledAtMs >= input.resources[index - 1].sampledAtMs));
    const firstQuarter = input.resources.filter(({ sampledAtMs }) =>
      sampledAtMs <= input.configuration.durationMs / 4).length;
    const lastQuarter = input.resources.filter(({ sampledAtMs }) =>
      sampledAtMs >= input.configuration.durationMs * 3 / 4).length;
    const lastSampleAtMs = input.resources.at(-1)?.sampledAtMs ?? 0;
    if (!timestampsValid || firstQuarter < 5 || lastQuarter < 5 ||
        lastSampleAtMs < input.configuration.durationMs - 60_000 ||
        lastSampleAtMs > elapsed + 60_000) {
      runErrors.push("native resource samples do not span the required duration");
    }
    if (growth === null) runErrors.push("native soak lacks 40 process-tree RSS samples");
    else if (growth > MAX_LATE_RSS_GROWTH_BYTES) {
      runErrors.push(`late median process-tree RSS grew ${growth} bytes, above ${MAX_LATE_RSS_GROWTH_BYTES}`);
    }
    if (input.platform.os === "linux") {
      if (webKitFdCounts.length !== input.resources.length || webKitFdCounts.length < 40) {
        runErrors.push("full Linux native soak lacks WebKit shared-memory descriptor samples");
      } else if (webKitFdGrowth !== null && webKitFdGrowth > MAX_WEBKIT_SHARED_MEMORY_FD_GROWTH) {
        runErrors.push(`WebKit shared-memory descriptors grew ${webKitFdGrowth}, above ${MAX_WEBKIT_SHARED_MEMORY_FD_GROWTH}`);
      }
    }
    const modes = new Set(input.scenarios.filter(({ id }) => id === "window-workspace")
      .map(({ windowMode }) => windowMode));
    if (!modes.has("warm") || !modes.has("fresh")) {
      runErrors.push("native soak did not exercise both warm and fresh window creation");
    }
  }
  if (input.scenarios.length > 0) {
    for (const scenario of input.configuration.scenarios) {
      if (!input.scenarios.some(({ id }) => id === scenario)) {
        runErrors.push(`native soak did not execute ${scenario}`);
      }
    }
  }
  const failureArtifacts = [
    ...new Set(
      input.scenarios.flatMap(({ failureArtifacts }) => failureArtifacts),
    ),
  ];

  return {
    schemaVersion: 1,
    ...(input.harnessCommit ? { harnessCommit: input.harnessCommit } : {}),
    build: input.build,
    platform: input.platform,
    configuration: input.configuration,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    resources: {
      sampleCount: input.resources.length,
      baselineRssBytes: input.resources[0]?.rssBytes ?? null,
      finalRssBytes: input.resources.at(-1)?.rssBytes ?? null,
      peakRssBytes:
        input.resources.length > 0
          ? Math.max(...input.resources.map(({ rssBytes }) => rssBytes))
          : null,
      samples: input.resources,
      lateMedianGrowthBytes: growth,
      maxAllowedLateGrowthBytes: MAX_LATE_RSS_GROWTH_BYTES,
      baselineWebKitSharedMemoryFds: webKitFdCounts[0] ?? null,
      peakWebKitSharedMemoryFds: webKitFdCounts.length > 0 ? Math.max(...webKitFdCounts) : null,
      lateMedianWebKitSharedMemoryFdGrowth: webKitFdGrowth,
      maxAllowedWebKitSharedMemoryFdGrowth: MAX_WEBKIT_SHARED_MEMORY_FD_GROWTH,
    },
    timings: {
      sampleCount: durations.length,
      p50Ms: nearestRank(durations, 0.5),
      p95Ms: nearestRank(durations, 0.95),
    },
    scenarios: input.scenarios,
    failureArtifacts,
    runErrors,
    passed:
      input.scenarios.length > 0 &&
      runErrors.length === 0 &&
      input.scenarios.every(({ outcome }) => outcome === "passed"),
  };
}
