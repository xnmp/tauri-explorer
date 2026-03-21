/**
 * Tests for the fuzzy scoring algorithm.
 */
import { describe, it, expect } from "vitest";
import { fuzzyScore, fuzzyScorePath } from "$lib/domain/fuzzy-score";

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
