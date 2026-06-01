import { describe, it, expect } from "vitest";
import { findNextWordBoundary, findPrevWordBoundary } from "$lib/domain/word-boundary";

describe("findNextWordBoundary", () => {
  it("stops at underscores", () => {
    expect(findNextWordBoundary("hello_world", 0)).toBe(5);
    expect(findNextWordBoundary("hello_world", 5)).toBe(6);
    expect(findNextWordBoundary("hello_world", 6)).toBe(11);
  });

  it("stops at hyphens", () => {
    expect(findNextWordBoundary("my-file-name", 0)).toBe(2);
    expect(findNextWordBoundary("my-file-name", 3)).toBe(7);
  });

  it("stops at dots", () => {
    expect(findNextWordBoundary("file.txt", 0)).toBe(4);
    expect(findNextWordBoundary("file.txt", 4)).toBe(5);
    expect(findNextWordBoundary("file.txt", 5)).toBe(8);
  });

  it("stops at camelCase boundaries", () => {
    expect(findNextWordBoundary("camelCase", 0)).toBe(5);
    expect(findNextWordBoundary("camelCase", 5)).toBe(9);
  });

  it("handles consecutive uppercase (acronyms)", () => {
    expect(findNextWordBoundary("XMLParser", 0)).toBe(3);
    expect(findNextWordBoundary("XMLParser", 3)).toBe(9);
  });

  it("stops at digit boundaries", () => {
    expect(findNextWordBoundary("file123name", 0)).toBe(4);
    expect(findNextWordBoundary("file123name", 4)).toBe(7);
    expect(findNextWordBoundary("file123name", 7)).toBe(11);
  });

  it("returns text.length at end", () => {
    expect(findNextWordBoundary("abc", 3)).toBe(3);
  });
});

describe("findPrevWordBoundary", () => {
  it("stops at underscores", () => {
    expect(findPrevWordBoundary("hello_world", 11)).toBe(6);
    expect(findPrevWordBoundary("hello_world", 6)).toBe(5);
    expect(findPrevWordBoundary("hello_world", 5)).toBe(0);
  });

  it("stops at hyphens", () => {
    expect(findPrevWordBoundary("my-file-name", 12)).toBe(8);
    expect(findPrevWordBoundary("my-file-name", 7)).toBe(3);
  });

  it("stops at dots", () => {
    expect(findPrevWordBoundary("file.txt", 8)).toBe(5);
    expect(findPrevWordBoundary("file.txt", 5)).toBe(4);
    expect(findPrevWordBoundary("file.txt", 4)).toBe(0);
  });

  it("stops at camelCase boundaries", () => {
    expect(findPrevWordBoundary("camelCase", 9)).toBe(5);
    expect(findPrevWordBoundary("camelCase", 5)).toBe(0);
  });

  it("handles consecutive uppercase (acronyms)", () => {
    expect(findPrevWordBoundary("XMLParser", 9)).toBe(3);
    expect(findPrevWordBoundary("XMLParser", 3)).toBe(0);
  });

  it("stops at digit boundaries", () => {
    expect(findPrevWordBoundary("file123name", 11)).toBe(7);
    expect(findPrevWordBoundary("file123name", 7)).toBe(4);
    expect(findPrevWordBoundary("file123name", 4)).toBe(0);
  });

  it("returns 0 at start", () => {
    expect(findPrevWordBoundary("abc", 0)).toBe(0);
  });
});
