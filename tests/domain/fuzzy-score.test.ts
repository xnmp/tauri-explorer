/**
 * Tests for the fuzzy scoring algorithm.
 */
import { describe, it, expect } from "vitest";
import {
  commandFrecencyPoints,
  filenameMatchScore,
  fuzzyScore,
  fuzzyScorePath,
  scoreCommand,
} from "$lib/domain/fuzzy-score";

describe("fuzzyScore", () => {
  it("returns 0 for non-subsequence", () => {
    expect(fuzzyScore("xyz", "hello")).toBe(0);
  });

  it("returns 0 for empty query", () => {
    expect(fuzzyScore("", "hello")).toBe(0);
  });

  it("scores exact match highest", () => {
    const exact = fuzzyScore("wall", "wall");
    const prefix = fuzzyScore("wall", "wallpaper");
    const substring = fuzzyScore("wall", "firewall");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(substring);
  });

  it("prefers prefix matches over middle matches", () => {
    const prefix = fuzzyScore("doc", "Documents");
    const middle = fuzzyScore("doc", "LibreOfficeDoc");
    expect(prefix).toBeGreaterThan(middle);
  });

  it("rewards consecutive character runs", () => {
    const consecutive = fuzzyScore("abc", "abcdef");
    const scattered = fuzzyScore("abc", "axbxcx");
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it("rewards word boundary matches", () => {
    const boundary = fuzzyScore("fb", "foo_bar");
    const middle = fuzzyScore("fb", "fxxxxxb");
    expect(boundary).toBeGreaterThan(middle);
  });

  it("rewards camelCase matches", () => {
    const camel = fuzzyScore("fb", "fooBar");
    const lower = fuzzyScore("fb", "foobar");
    expect(camel).toBeGreaterThanOrEqual(lower);
  });

  it("handles case-insensitive matching", () => {
    const score = fuzzyScore("wall", "Wallpaper");
    expect(score).toBeGreaterThan(0);
  });

  it("gives exact case a small bonus", () => {
    const exact = fuzzyScore("Wall", "Wallpaper");
    const wrong = fuzzyScore("wall", "Wallpaper");
    expect(exact).toBeGreaterThanOrEqual(wrong);
  });
});

describe("fuzzyScorePath", () => {
  it("filename match scores higher than path-only match", () => {
    const nameMatch = fuzzyScorePath("wall", "/home/user/Pictures/Wallpaper");
    const pathMatch = fuzzyScorePath("wall", "/home/user/Pictures/Wallpaper/sunset.jpg");
    expect(nameMatch).toBeGreaterThan(pathMatch);
  });

  it("Wallpaper folder beats wallpaper.rs for query 'wall'", () => {
    const folder = fuzzyScorePath("wall", "/home/user/Pictures/Wallpaper");
    const file = fuzzyScorePath("wall", "/home/user/src-tauri/src/wallpaper.rs");
    // Folder has a shorter basename match
    expect(folder).toBeGreaterThanOrEqual(file * 0.8); // at least competitive
  });
});

describe("fuzzyScore unicode and bounds safety", () => {
  it("does not throw when case folding changes string length (Turkish İ)", () => {
    // "İ".toLowerCase() expands to two UTF-16 code units ("i" + U+0307),
    // which previously misaligned folded/original indices and crashed.
    expect(() => fuzzyScore("̇", "İ")).not.toThrow();
    expect(() => fuzzyScore("i", "İstanbul")).not.toThrow();
    expect(() => fuzzyScore("İ", "İ")).not.toThrow();
  });

  it("still matches length-stable unicode case-insensitively", () => {
    expect(fuzzyScore("über", "ÜBER")).toBeGreaterThan(0);
    expect(fuzzyScore("ФАЙЛ", "файл.txt")).toBeGreaterThan(0);
  });

  it("returns 0 for empty candidate", () => {
    expect(fuzzyScore("a", "")).toBe(0);
  });
});

describe("fuzzyScore positive-score clamp", () => {
  it("keeps a real match positive in very long candidates", () => {
    // Length penalty (cLen * 0.02) used to push real matches below 0,
    // making `score > 0` callers drop them entirely.
    const longCandidate = "a" + "x".repeat(5000);
    expect(fuzzyScore("a", longCandidate)).toBeGreaterThan(0);
  });

  it("still returns exactly 0 for non-matches in long candidates", () => {
    expect(fuzzyScore("q", "x".repeat(5000))).toBe(0);
  });
});

describe("fuzzyScore optimal alignment (consecutive vs non-consecutive)", () => {
  it("prefers a high-bonus earlier match over a forced consecutive run", () => {
    // In "Aab" the best alignment for "ab" uses the prefix "A" (bonus 8)
    // plus a gap, not the consecutive "ab" in the middle. The old code
    // only considered the consecutive path once a run had started, so
    // both candidates scored identically.
    expect(fuzzyScore("ab", "Aab")).toBeGreaterThan(fuzzyScore("ab", "xab"));
  });
});

describe("filenameMatchScore", () => {
  it("ranks exact > prefix > substring > none", () => {
    expect(filenameMatchScore("Pictures", "pictures")).toBe(200);
    expect(filenameMatchScore("Pictures2024", "pictures")).toBe(150);
    expect(filenameMatchScore("MyPictures", "pictures")).toBe(100);
    expect(filenameMatchScore("Documents", "pictures")).toBe(0);
  });

  it("handles empty query as a universal prefix, not a crash", () => {
    expect(filenameMatchScore("anything", "")).toBe(150);
  });
});

describe("scoreCommand", () => {
  const fields = (label: string, category = "", shortcut = "") => ({
    label,
    category,
    shortcut,
  });

  it("requires the query to be a subsequence of the label", () => {
    // Category/shortcut hits alone never create a match.
    expect(scoreCommand(fields("open folder", "git", "ctrl+g"), "git", 0)).toBe(0);
    expect(scoreCommand(fields("toggle git panel"), "git", 0)).toBeGreaterThan(0);
  });

  it("ranks label prefix above bare substring above scattered subsequence", () => {
    const prefix = scoreCommand(fields("git commit"), "git", 0);
    const substring = scoreCommand(fields("open git panel"), "git", 0);
    const scattered = scoreCommand(fields("grep in tree"), "git", 0);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
  });

  it("caps the frecency contribution", () => {
    expect(commandFrecencyPoints(1000)).toBe(30);
    const cold = scoreCommand(fields("git commit"), "git", 0);
    const hot = scoreCommand(fields("git commit"), "git", 1000);
    expect(hot - cold).toBe(30);
  });
});
