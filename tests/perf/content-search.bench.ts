/**
 * Content search performance benchmarks.
 * Issue: tauri-x129
 *
 * Benchmarks the REAL implementations driving ContentSearchDialog:
 * domain/content-search-flatten (incremental flatten, filter rebuild) and
 * domain/virtual-layout (offsets + binary search used by VirtualList's
 * variable-height mode). Run with: bun run test -- tests/perf/content-search.bench.ts
 */

import { describe, it } from "vitest";
import { benchmark, formatResult, assertPerformance } from "./perf-utils";
import {
  flattenBatch,
  rebuildAllFlattened,
  type FlattenedResult,
} from "../../src/lib/domain/content-search-flatten";
import {
  computeOffsets,
  firstVisibleIndex,
} from "../../src/lib/domain/virtual-layout";
import type { ContentSearchResult, ContentMatch } from "../../src/lib/api/files";

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

const ROW_HEIGHT = (item: FlattenedResult) => (item.isFirstInFile ? 54 : 30);

// All files expanded so every match flattens to a row (worst case).
function expandedSet(results: ContentSearchResult[]): Set<string> {
  return new Set(results.map((r) => r.path));
}

// --- Shared test fixtures ---

const smallResults = generateSearchResults(50, 10); // 500 matches
const smallExpanded = expandedSet(smallResults);
const smallBatch = generateSearchResults(5, 10); // 50 new matches

const largeResults = generateSearchResults(200, 10); // 2000 matches
const largeExpanded = expandedSet(largeResults);
const largeFlattened = rebuildAllFlattened(largeResults, "", largeExpanded);
const largeLayout = computeOffsets(largeFlattened, ROW_HEIGHT);

// --- Benchmarks ---

describe("Content Search: Incremental Flatten (flattenBatch)", () => {
  it("flattens a 50-match batch under 0.5ms", () => {
    const batchExpanded = expandedSet(smallBatch);
    const result = benchmark(
      "flattenBatch-50",
      () => flattenBatch(smallBatch, "", batchExpanded),
      200
    );
    console.log(formatResult(result));
    assertPerformance(result, 0.5);
  });

  it("full re-flatten of 500 matches (filter change baseline) under 2ms", () => {
    const result = benchmark(
      "rebuildAllFlattened-500",
      () => rebuildAllFlattened(smallResults, "", smallExpanded),
      200
    );
    console.log(formatResult(result));
    assertPerformance(result, 2);
  });

  it("filtered re-flatten of 500 matches under 2ms", () => {
    const result = benchmark(
      "rebuildAllFlattened-500-filtered",
      () => rebuildAllFlattened(smallResults, "value7", smallExpanded),
      200
    );
    console.log(formatResult(result));
    assertPerformance(result, 2);
  });
});

describe("Content Search: VirtualList layout (computeOffsets)", () => {
  it("computes offsets for ~2200 rows under 1ms", () => {
    const result = benchmark(
      "computeOffsets-2200",
      () => computeOffsets(largeFlattened, ROW_HEIGHT),
      200
    );
    console.log(formatResult(result));
    assertPerformance(result, 1);
  });

  it("computes offsets for 500 rows under 0.3ms", () => {
    const items500 = largeFlattened.slice(0, 500);
    const result = benchmark(
      "computeOffsets-500",
      () => computeOffsets(items500, ROW_HEIGHT),
      200
    );
    console.log(formatResult(result));
    assertPerformance(result, 0.3);
  });
});

describe("Content Search: scroll lookup (firstVisibleIndex)", () => {
  it("binary-search lookups across the scroll range are near-instant", () => {
    const positions = [0, 1000, 10_000, 30_000, largeLayout.totalHeight - 1];
    const result = benchmark(
      "firstVisibleIndex-lookups",
      () => {
        for (const top of positions) {
          firstVisibleIndex(largeLayout.offsets, top);
        }
      },
      1000
    );
    console.log(formatResult(result));
    // Measurement noise floor on a loaded machine; an O(n) regression over
    // ~2200 offsets would exceed this by orders of magnitude.
    assertPerformance(result, 0.1);
  });
});
