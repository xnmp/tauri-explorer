/**
 * Performance testing utilities.
 * Issue: tauri-explorer-aj9u
 *
 * Uses Performance API for accurate timing measurements.
 */

export interface PerfResult {
  name: string;
  duration: number;
  iterations?: number;
  averageMs?: number;
  minMs?: number;
  maxMs?: number;
}

/**
 * Measure execution time of a function.
 * Uses performance.mark() and performance.measure() APIs.
 */
export function measureSync<T>(name: string, fn: () => T): { result: T; perf: PerfResult } {
  const startMark = `${name}-start`;
  const endMark = `${name}-end`;

  performance.mark(startMark);
  const result = fn();
  performance.mark(endMark);

  const measure = performance.measure(name, startMark, endMark);
  const duration = measure.duration;

  // Cleanup marks
  performance.clearMarks(startMark);
  performance.clearMarks(endMark);
  performance.clearMeasures(name);

  return {
    result,
    perf: { name, duration },
  };
}

/**
 * Measure execution time of an async function.
 */
export async function measureAsync<T>(
  name: string,
  fn: () => Promise<T>
): Promise<{ result: T; perf: PerfResult }> {
  const startMark = `${name}-start`;
  const endMark = `${name}-end`;

  performance.mark(startMark);
  const result = await fn();
  performance.mark(endMark);

  const measure = performance.measure(name, startMark, endMark);
  const duration = measure.duration;

  // Cleanup
  performance.clearMarks(startMark);
  performance.clearMarks(endMark);
  performance.clearMeasures(name);

  return {
    result,
    perf: { name, duration },
  };
}

/**
 * Run a benchmark multiple times and collect statistics.
 */
export function benchmark(name: string, fn: () => void, iterations = 100): PerfResult {
  const durations: number[] = [];

  // Warmup runs
  for (let i = 0; i < 5; i++) {
    fn();
  }

  // Actual benchmark runs
  for (let i = 0; i < iterations; i++) {
    const { perf } = measureSync(`${name}-iter-${i}`, fn);
    durations.push(perf.duration);
  }

  const total = durations.reduce((a, b) => a + b, 0);
  const averageMs = total / iterations;
  const minMs = Math.min(...durations);
  const maxMs = Math.max(...durations);

  return {
    name,
    duration: total,
    iterations,
    averageMs,
    minMs,
    maxMs,
  };
}

/**
 * Run an async benchmark multiple times.
 */
export async function benchmarkAsync(
  name: string,
  fn: () => Promise<void>,
  iterations = 100
): Promise<PerfResult> {
  const durations: number[] = [];

  // Warmup runs
  for (let i = 0; i < 5; i++) {
    await fn();
  }

  // Actual benchmark runs
  for (let i = 0; i < iterations; i++) {
    const { perf } = await measureAsync(`${name}-iter-${i}`, fn);
    durations.push(perf.duration);
  }

  const total = durations.reduce((a, b) => a + b, 0);
  const averageMs = total / iterations;
  const minMs = Math.min(...durations);
  const maxMs = Math.max(...durations);

  return {
    name,
    duration: total,
    iterations,
    averageMs,
    minMs,
    maxMs,
  };
}

/**
 * Format performance result for console output.
 */
export function formatResult(result: PerfResult): string {
  if (result.iterations) {
    return `${result.name}: avg=${result.averageMs?.toFixed(2)}ms, min=${result.minMs?.toFixed(2)}ms, max=${result.maxMs?.toFixed(2)}ms (${result.iterations} iterations)`;
  }
  return `${result.name}: ${result.duration.toFixed(2)}ms`;
}

/**
 * Assert performance is within threshold.
 */
export function assertPerformance(result: PerfResult, maxMs: number, message?: string): void {
  const actual = result.averageMs ?? result.duration;
  if (actual > maxMs) {
    throw new Error(
      message ??
        `Performance threshold exceeded: ${result.name} took ${actual.toFixed(2)}ms, max allowed: ${maxMs}ms`
    );
  }
}
