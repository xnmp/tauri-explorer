/**
 * Mock data generators for performance testing.
 * Issue: tauri-explorer-aj9u
 */

import type { FileEntry } from "$lib/domain/file";

/**
 * Generate mock file entries for performance testing.
 * Creates a mix of files and directories with realistic names.
 */
export function generateMockEntries(count: number): FileEntry[] {
  const entries: FileEntry[] = [];
  const extensions = [".txt", ".md", ".ts", ".js", ".json", ".css", ".html", ".png", ".jpg", ".pdf"];
  const folderPrefixes = ["folder", "dir", "project", "docs", "src", "lib", "tests", "assets"];

  for (let i = 0; i < count; i++) {
    const isDirectory = i % 5 === 0; // 20% directories

    if (isDirectory) {
      const prefix = folderPrefixes[i % folderPrefixes.length];
      entries.push({
        name: `${prefix}_${String(i).padStart(5, "0")}`,
        path: `/mock/path/${prefix}_${String(i).padStart(5, "0")}`,
        kind: "directory",
        size: 0,
        modified: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    } else {
      const ext = extensions[i % extensions.length];
      const name = `file_${String(i).padStart(5, "0")}${ext}`;
      entries.push({
        name,
        path: `/mock/path/${name}`,
        kind: "file",
        size: Math.floor(Math.random() * 10 * 1024 * 1024), // 0-10MB
        modified: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
  }

  return entries;
}

/**
 * Standard test data sizes for benchmarking.
 */
export const TEST_SIZES = {
  small: 100,
  medium: 1000,
  large: 10000,
} as const;

/**
 * Pre-generated test data for consistent benchmarking.
 */
export const testData = {
  small: generateMockEntries(TEST_SIZES.small),
  medium: generateMockEntries(TEST_SIZES.medium),
  large: generateMockEntries(TEST_SIZES.large),
};
