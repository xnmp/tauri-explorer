/**
 * Directory scan and render pipeline benchmarks.
 * Issue: tauri-explorer-s29y
 *
 * Benchmarks the full data processing pipeline for directory contents:
 * sort -> filter -> virtual list calculation -> selection lookups.
 * Simulates what happens after Rust returns directory entries.
 */

import { describe, it, expect } from "vitest";
import { testData, TEST_SIZES } from "./mock-data";
import { benchmark, formatResult, assertPerformance } from "./perf-utils";
import { sortEntries, filterHidden } from "$lib/domain/file";
import type { FileEntry } from "$lib/domain/file";

/** Simulate the full directory render pipeline */
function directoryRenderPipeline(entries: FileEntry[]): {
  sorted: FileEntry[];
  filtered: FileEntry[];
  visibleSlice: FileEntry[];
} {
  // Step 1: Sort
  const sorted = sortEntries(entries, "name", true);

  // Step 2: Filter hidden files
  const filtered = filterHidden(sorted, false);

  // Step 3: Virtual list - take visible slice (simulate 50 visible items)
  const visibleSlice = filtered.slice(0, 50);

  return { sorted, filtered, visibleSlice };
}

describe("Directory Scan Pipeline Performance", () => {
  it("processes 100 entries (small dir) under 1ms", () => {
    const result = benchmark(
      "dirPipeline-100",
      () => directoryRenderPipeline(testData.small),
      200
    );
    console.log(formatResult(result));
    assertPerformance(result, 1);
  });

  it("processes 1000 entries (medium dir) under 10ms", () => {
    const result = benchmark(
      "dirPipeline-1000",
      () => directoryRenderPipeline(testData.medium),
      100
    );
    console.log(formatResult(result));
    assertPerformance(result, 10);
  });

  it("processes 10000 entries (large dir) under 50ms", () => {
    const result = benchmark(
      "dirPipeline-10000",
      () => directoryRenderPipeline(testData.large),
      50
    );
    console.log(formatResult(result));
    assertPerformance(result, 50);
  });

  it("re-sorts 10000 entries by size under 50ms", () => {
    const result = benchmark(
      "dirPipeline-resort-size-10000",
      () => sortEntries(testData.large, "size", false),
      50
    );
    console.log(formatResult(result));
    assertPerformance(result, 50);
  });

  it("re-sorts 10000 entries by modified under 50ms", () => {
    const result = benchmark(
      "dirPipeline-resort-modified-10000",
      () => sortEntries(testData.large, "modified", false),
      50
    );
    console.log(formatResult(result));
    assertPerformance(result, 50);
  });

  it("handles rapid navigation (10 consecutive pipeline runs) under 500ms", () => {
    const result = benchmark(
      "dirPipeline-rapid-nav",
      () => {
        for (let i = 0; i < 10; i++) {
          directoryRenderPipeline(testData.large);
        }
      },
      20
    );
    console.log(formatResult(result));
    assertPerformance(result, 500);
  });
});
