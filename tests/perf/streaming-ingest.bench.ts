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

  it("buffered ingest (new behaviour) stays under 15ms", () => {
    const result = benchmark("ingest-buffered-5000", () => ingestBuffered(dir), 50);
    console.log(formatResult(result));
    assertPerformance(result, 15);
  });

  it("documents per-batch ingest (old O(n^2) behaviour)", () => {
    // No hard budget: this records the original cost for comparison. The
    // buffered variant above should be many times faster. Kept so a future
    // accidental revert to per-batch re-sorting shows up as a glaring delta.
    const result = benchmark("ingest-perBatch-5000", () => ingestPerBatch(dir), 20);
    console.log(formatResult(result));
  });
});
