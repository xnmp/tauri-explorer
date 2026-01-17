/**
 * Svelte rendering performance benchmarks.
 * Issue: tauri-explorer-aj9u
 *
 * Tests data processing and rendering-related logic performance.
 * Run with: bun run test -- tests/perf/render.bench.ts
 */

import { describe, it, expect } from "vitest";
import { testData, TEST_SIZES } from "./mock-data";
import { benchmark, formatResult, assertPerformance } from "./perf-utils";
import { sortEntries, filterHidden, formatSize } from "$lib/domain/file";
import type { FileEntry } from "$lib/domain/file";

describe("Data Processing Performance", () => {
  describe("sortEntries", () => {
    it("sorts 100 entries under 1ms", () => {
      const result = benchmark(
        "sortEntries-100",
        () => sortEntries(testData.small, "name", true),
        100
      );
      console.log(formatResult(result));
      assertPerformance(result, 1);
    });

    it("sorts 1000 entries under 5ms", () => {
      const result = benchmark(
        "sortEntries-1000",
        () => sortEntries(testData.medium, "name", true),
        100
      );
      console.log(formatResult(result));
      assertPerformance(result, 5);
    });

    it("sorts 10000 entries under 50ms", () => {
      const result = benchmark(
        "sortEntries-10000",
        () => sortEntries(testData.large, "name", true),
        50
      );
      console.log(formatResult(result));
      assertPerformance(result, 50);
    });

    it("sorts by size under 50ms for 10000 entries", () => {
      const result = benchmark(
        "sortEntries-size-10000",
        () => sortEntries(testData.large, "size", true),
        50
      );
      console.log(formatResult(result));
      assertPerformance(result, 50);
    });

    it("sorts by modified under 50ms for 10000 entries", () => {
      const result = benchmark(
        "sortEntries-modified-10000",
        () => sortEntries(testData.large, "modified", true),
        50
      );
      console.log(formatResult(result));
      assertPerformance(result, 50);
    });
  });

  describe("filterHidden", () => {
    it("filters 100 entries under 0.5ms", () => {
      const result = benchmark(
        "filterHidden-100",
        () => filterHidden(testData.small, false),
        100
      );
      console.log(formatResult(result));
      assertPerformance(result, 0.5);
    });

    it("filters 1000 entries under 2ms", () => {
      const result = benchmark(
        "filterHidden-1000",
        () => filterHidden(testData.medium, false),
        100
      );
      console.log(formatResult(result));
      assertPerformance(result, 2);
    });

    it("filters 10000 entries under 10ms", () => {
      const result = benchmark(
        "filterHidden-10000",
        () => filterHidden(testData.large, false),
        50
      );
      console.log(formatResult(result));
      assertPerformance(result, 10);
    });
  });

  describe("formatSize", () => {
    const sizes = [0, 512, 1024, 1024 * 1024, 1024 * 1024 * 1024];

    it("formats 10000 sizes under 5ms", () => {
      const result = benchmark(
        "formatSize-10000",
        () => {
          for (let i = 0; i < 10000; i++) {
            formatSize(sizes[i % sizes.length]);
          }
        },
        50
      );
      console.log(formatResult(result));
      assertPerformance(result, 5);
    });
  });
});

describe("Virtual List Calculations", () => {
  const itemHeight = 32;
  const viewportHeight = 600;
  const buffer = 3;

  function calculateVisibleRange(
    scrollTop: number,
    itemCount: number
  ): { startIndex: number; endIndex: number } {
    const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer);
    const visibleCount = Math.ceil(viewportHeight / itemHeight) + buffer * 2;
    const endIndex = Math.min(startIndex + visibleCount, itemCount);
    return { startIndex, endIndex };
  }

  function sliceVisibleItems<T>(items: T[], scrollTop: number): T[] {
    const { startIndex, endIndex } = calculateVisibleRange(scrollTop, items.length);
    return items.slice(startIndex, endIndex);
  }

  it("calculates visible range for 100 items under 0.1ms", () => {
    const result = benchmark(
      "visibleRange-100",
      () => calculateVisibleRange(0, TEST_SIZES.small),
      1000
    );
    console.log(formatResult(result));
    assertPerformance(result, 0.1);
  });

  it("slices visible items from 10000 entries under 1ms", () => {
    const result = benchmark(
      "sliceVisibleItems-10000",
      () => sliceVisibleItems(testData.large, 5000),
      100
    );
    console.log(formatResult(result));
    assertPerformance(result, 1);
  });

  it("handles rapid scroll calculations", () => {
    // Simulate rapid scrolling - 100 scroll events
    const result = benchmark(
      "rapidScroll-10000",
      () => {
        for (let scrollTop = 0; scrollTop < 100000; scrollTop += 1000) {
          sliceVisibleItems(testData.large, scrollTop);
        }
      },
      50
    );
    console.log(formatResult(result));
    // 100 scroll calculations should complete under 50ms
    assertPerformance(result, 50);
  });
});

describe("Selection Performance", () => {
  function selectByIndex(
    entries: FileEntry[],
    selectedPaths: Set<string>,
    index: number
  ): Set<string> {
    const newSet = new Set(selectedPaths);
    if (index >= 0 && index < entries.length) {
      newSet.add(entries[index].path);
    }
    return newSet;
  }

  function selectRange(
    entries: FileEntry[],
    startIndex: number,
    endIndex: number
  ): Set<string> {
    const paths = new Set<string>();
    const [start, end] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    for (let i = start; i <= end && i < entries.length; i++) {
      paths.add(entries[i].path);
    }
    return paths;
  }

  function selectAll(entries: FileEntry[]): Set<string> {
    return new Set(entries.map((e) => e.path));
  }

  it("single selection in 10000 entries under 0.1ms", () => {
    const result = benchmark(
      "selectSingle-10000",
      () => selectByIndex(testData.large, new Set(), 5000),
      100
    );
    console.log(formatResult(result));
    assertPerformance(result, 0.1);
  });

  it("range selection of 1000 items under 5ms", () => {
    const result = benchmark(
      "selectRange-1000",
      () => selectRange(testData.large, 1000, 2000),
      100
    );
    console.log(formatResult(result));
    assertPerformance(result, 5);
  });

  it("select all 10000 entries under 10ms", () => {
    const result = benchmark(
      "selectAll-10000",
      () => selectAll(testData.large),
      50
    );
    console.log(formatResult(result));
    assertPerformance(result, 10);
  });

  it("checking selection status in large set under 0.01ms", () => {
    const selected = selectAll(testData.large);
    const result = benchmark(
      "checkSelected-10000",
      () => {
        selected.has(testData.large[5000].path);
      },
      1000
    );
    console.log(formatResult(result));
    assertPerformance(result, 0.01);
  });
});

describe("Memory Efficiency", () => {
  it("processes large datasets without error", () => {
    // Process large dataset to verify no OOM or performance issues
    const largeData = testData.large;
    const sorted = sortEntries(largeData, "name");
    const filtered = filterHidden(sorted, false);

    // Verify data is processed correctly
    expect(sorted.length).toBe(TEST_SIZES.large);
    expect(filtered.length).toBeLessThanOrEqual(TEST_SIZES.large);

    console.log(
      `Processed ${TEST_SIZES.large} entries: sorted=${sorted.length}, filtered=${filtered.length}`
    );
  });
});
