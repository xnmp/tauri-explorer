export function nearestRank(
  values: readonly number[],
  percentile: number,
): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1];
}

export function summarizeDurations(values: readonly number[]): {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
} {
  return {
    sampleCount: values.length,
    p50Ms: nearestRank(values, 0.5),
    p95Ms: nearestRank(values, 0.95),
  };
}

export type CompactDurationSummary = {
  sampleCount: number;
  p50: number | null;
  p95: number | null;
};

export function compactSummary(values: readonly number[]): CompactDurationSummary {
  const summary = summarizeDurations(values);
  return {
    sampleCount: summary.sampleCount,
    p50: summary.p50Ms,
    p95: summary.p95Ms,
  };
}
