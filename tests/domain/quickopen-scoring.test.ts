/**
 * Regression test: QuickOpen filename matches must score higher than path-only matches.
 * Issue: fix/quickopen-filename-scoring
 *
 * e.g. searching "pictures" should rank ~/Pictures above ~/Pictures/Wallpaper
 */
import { describe, it, expect } from "vitest";

// Reproduce the scoring functions from QuickOpen.svelte
function filenameMatchScore(name: string, queryLower: string): number {
  const nameLower = name.toLowerCase();
  if (nameLower === queryLower) return 200;
  if (nameLower.startsWith(queryLower)) return 150;
  if (nameLower.includes(queryLower)) return 100;
  return 0;
}

function scoreEntry(name: string, path: string, queryLower: string): number {
  const nameScore = filenameMatchScore(name, queryLower);
  if (nameScore > 0) return nameScore;
  if (path.toLowerCase().includes(queryLower)) return 30;
  return 0;
}

describe("QuickOpen filename scoring", () => {
  it("exact filename match scores highest", () => {
    expect(filenameMatchScore("Pictures", "pictures")).toBe(200);
  });

  it("prefix filename match scores higher than substring", () => {
    expect(filenameMatchScore("Pictures", "pic")).toBeGreaterThan(
      filenameMatchScore("epic-pictures", "pic")
    );
  });

  it("filename match scores much higher than path-only match", () => {
    // ~/Pictures should rank above ~/Pictures/Wallpaper when searching "pictures"
    const picturesScore = scoreEntry("Pictures", "/home/user/Pictures", "pictures");
    const wallpaperScore = scoreEntry("Wallpaper", "/home/user/Pictures/Wallpaper", "pictures");

    expect(picturesScore).toBeGreaterThan(wallpaperScore);
    // The gap should be significant (at least 100 points)
    expect(picturesScore - wallpaperScore).toBeGreaterThanOrEqual(100);
  });

  it("no match returns 0", () => {
    expect(scoreEntry("readme.txt", "/home/user/readme.txt", "zzzzz")).toBe(0);
  });

  it("path-only match still returns a positive score", () => {
    expect(scoreEntry("Wallpaper", "/home/user/Pictures/Wallpaper", "pictures")).toBeGreaterThan(0);
  });
});
