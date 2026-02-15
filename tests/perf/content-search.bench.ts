/**
 * Content search performance benchmarks.
 * Issue: tauri-x129
 *
 * Tests incremental flattening, offset computation, and page slicing
 * that drive the ContentSearchDialog's performance.
 * Run with: bun run test -- tests/perf/content-search.bench.ts
 */

import { describe, it } from "vitest";
import { benchmark, formatResult, assertPerformance } from "./perf-utils";

// --- Types mirroring ContentSearchDialog ---

interface ContentMatch {
  lineNumber: number;
  column: number;
  lineContent: string;
  matchStart: number;
  matchEnd: number;
}

interface ContentSearchResult {
  path: string;
  relativePath: string;
  matches: ContentMatch[];
}

interface FlattenedResult {
  filePath: string;
  relativePath: string;
  match: ContentMatch;
  isFirstInFile: boolean;
}

// --- Mock data generators ---

function generateSearchResults(fileCount: number, matchesPerFile: number): ContentSearchResult[] {
  const results: ContentSearchResult[] = [];
  for (let f = 0; f < fileCount; f++) {
    const matches: ContentMatch[] = [];
    for (let m = 0; m < matchesPerFile; m++) {
      matches.push({
        lineNumber: m * 10 + 1,
        column: 5,
        lineContent: `  const value${m} = someFunction(arg1, arg2); // line ${m}`,
        matchStart: 8,
        matchEnd: 13 + String(m).length,
      });
    }
    results.push({
      path: `/home/user/project/src/module${f}/file${f}.ts`,
      relativePath: `src/module${f}/file${f}.ts`,
      matches,
    });
  }
  return results;
}

function flattenResults(results: ContentSearchResult[]): FlattenedResult[] {
  const flattened: FlattenedResult[] = [];
  for (const file of results) {
    let isFirst = true;
    for (const match of file.matches) {
      flattened.push({
        filePath: file.path,
        relativePath: file.relativePath,
        match,
        isFirstInFile: isFirst,
      });
      isFirst = false;
    }
  }
  return flattened;
}

function flattenBatchIncremental(
  existing: FlattenedResult[],
  newResults: ContentSearchResult[],
): FlattenedResult[] {
  const existingPaths = new Set(existing.map(r => r.filePath));
  const batch: FlattenedResult[] = [];
  for (const file of newResults) {
    let isFirst = !existingPaths.has(file.path);
    for (const match of file.matches) {
      batch.push({
        filePath: file.path,
        relativePath: file.relativePath,
        match,
        isFirstInFile: isFirst,
      });
      isFirst = false;
    }
  }
  return batch;
}

function computeOffsets(items: FlattenedResult[], itemHeight: number, headerHeight: number): { offsets: number[]; totalHeight: number } {
  const offsets = new Array(items.length);
  let cumulative = 0;
  for (let i = 0; i < items.length; i++) {
    offsets[i] = cumulative;
    cumulative += items[i].isFirstInFile ? headerHeight : itemHeight;
  }
  return { offsets, totalHeight: cumulative };
}

// --- Shared test fixtures ---

const smallResults = generateSearchResults(50, 10);  // 500 items
const smallFlattened = flattenResults(smallResults);
const smallBatch = generateSearchResults(5, 10);     // 50 new items

const largeResults = generateSearchResults(200, 10); // 2000 items
const largeFlattened = flattenResults(largeResults);
const largeOffsets = computeOffsets(largeFlattened, 28, 36);

// --- Benchmarks ---

describe("Content Search: Incremental Flatten", () => {
  it("appends 50 new results onto 500 existing under 0.5ms", () => {
    const result = benchmark(
      "flattenBatch-50-onto-500",
      () => flattenBatchIncremental(smallFlattened, smallBatch),
      200
    );
    console.log(formatResult(result));
    assertPerformance(result, 0.5);
  });

  it("full re-flatten of 500 items (filter change baseline)", () => {
    const result = benchmark(
      "fullFlatten-500",
      () => flattenResults(smallResults),
      200
    );
    console.log(formatResult(result));
    assertPerformance(result, 2);
  });
});

describe("Content Search: Offset Computation", () => {
  it("computes offsets for 2000 items under 1ms", () => {
    const result = benchmark(
      "computeOffsets-2000",
      () => computeOffsets(largeFlattened, 28, 36),
      200
    );
    console.log(formatResult(result));
    assertPerformance(result, 1);
  });

  it("computes offsets for 500 items under 0.3ms", () => {
    const items500 = largeFlattened.slice(0, 500);
    const result = benchmark(
      "computeOffsets-500",
      () => computeOffsets(items500, 28, 36),
      200
    );
    console.log(formatResult(result));
    assertPerformance(result, 0.3);
  });
});

describe("Content Search: Page Slice", () => {
  it("slices page of 200 items from 2000 under 0.1ms", () => {
    const result = benchmark(
      "pageSlice-200-from-2000",
      () => largeFlattened.slice(0, 200),
      500
    );
    console.log(formatResult(result));
    assertPerformance(result, 0.1);
  });

  it("slices mid-range page under 0.1ms", () => {
    const result = benchmark(
      "pageSlice-mid-200-from-2000",
      () => largeFlattened.slice(800, 1000),
      500
    );
    console.log(formatResult(result));
    assertPerformance(result, 0.1);
  });
});

describe("Content Search: scrollToSelected O(1) lookup", () => {
  it("O(1) offset lookup is near-instant", () => {
    const indices = [0, 100, 500, 999, 1500, 1999];
    const result = benchmark(
      "offsetLookup-O1",
      () => {
        for (const idx of indices) {
          const _offset = largeOffsets.offsets[idx];
        }
      },
      1000
    );
    console.log(formatResult(result));
    assertPerformance(result, 0.01);
  });
});
