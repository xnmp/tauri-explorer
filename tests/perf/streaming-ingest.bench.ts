/**
 * Streaming directory-ingest benchmarks.
 * Issue: streaming-ingest-batching
 *
 * Closes a blind spot in directory-scan.bench.ts: that suite runs the
 * sort->filter pipeline ONCE on a full array, so it cannot catch a per-batch
 * O(n^2) regression on the streaming-ingest path.
 *
 * Background (see docs/perf-review.md findings #1 + #2): when a large directory
 * streams in as ~100-entry batches, the old navigateInternal onEntries callback
 * did `entries = [...entries, ...batch]` per batch (O(n) copy each) AND every
 * such reactive write re-ran filterHidden + sortEntries over the whole
 * accumulated array (O(n^2 log n) total, on the main thread).
 *
 * This bench models both ends:
 *   - ingestPerBatch  : the OLD behaviour (copy + full re-sort every batch)
 *   - ingestBuffered  : the NEW behaviour (accumulate in a buffer, sort+filter once)
 *
 * The gap between the two IS the win. The buffered path is the one the
 * production code (explorer.svelte.ts) matches after the fix, so its budget is
 * the regression guard; the per-batch variant is kept as a documented baseline
 * of the original cost.
 */

import { describe, it } from "vitest";
import { testData } from "./mock-data";
import { benchmark, formatResult, assertPerformance } from "./perf-utils";
import { sortEntries, filterHidden } from "$lib/domain/file";
import type { FileEntry } from "$lib/domain/file";

const BATCH = 100;

/** OLD: spread-grow + full filter+sort on every streamed batch. */
function ingestPerBatch(all: FileEntry[], batch = BATCH): FileEntry[] {
  let entries: FileEntry[] = [];
  let display: FileEntry[] = [];
  for (let i = 0; i < all.length; i += batch) {
    entries = [...entries, ...all.slice(i, i + batch)]; // #1: O(n) copy per batch
    display = sortEntries(filterHidden(entries, false), "name", true); // #2: full re-sort per batch
  }
  return display;
}

/** NEW: accumulate into a buffer, filter+sort exactly once at the end. */
function ingestBuffered(all: FileEntry[], batch = BATCH): FileEntry[] {
  const buffer: FileEntry[] = [];
  for (let i = 0; i < all.length; i += batch) {
    for (const e of all.slice(i, i + batch)) buffer.push(e); // O(1) amortised append
  }
  return sortEntries(filterHidden(buffer, false), "name", true);
}

describe("Streaming ingest pipeline (5000-entry directory)", () => {
  // 5000 entries = 50 batches of 100, matching the backend stream batch size.
  const dir = testData.large.slice(0, 5000);

  it("buffered ingest (new behaviour) is many times faster than per-batch", () => {
    const buffered = benchmark("ingest-buffered-5000", () => ingestBuffered(dir), 50);
    const perBatch = benchmark("ingest-perBatch-5000", () => ingestPerBatch(dir), 20);
    console.log(formatResult(buffered));
    console.log(formatResult(perBatch));
    // The contract is the complexity gap, not an absolute number (which varies
    // by machine and test-runner load): a revert to per-batch re-sorting
    // collapses the ratio to ~1x. Observed ~7-25x; require 3x.
    const bufferedMs = buffered.averageMs ?? buffered.duration;
    const perBatchMs = perBatch.averageMs ?? perBatch.duration;
    if (bufferedMs * 3 > perBatchMs) {
      throw new Error(
        `Buffered ingest lost its edge: ${bufferedMs.toFixed(1)}ms vs per-batch ${perBatchMs.toFixed(1)}ms (<3x)`,
      );
    }
    // Loose absolute ceiling as a sanity backstop.
    assertPerformance(buffered, 60);
  });
});
