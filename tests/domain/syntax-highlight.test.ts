/**
 * Unit tests for syntax-highlight utility.
 * Covers highlightCode and hasLanguageSupport.
 */

import { describe, it, expect } from "vitest";
import { highlightCode, hasLanguageSupport } from "$lib/domain/syntax-highlight";

describe("hasLanguageSupport", () => {
  it("returns true for registered extensions", () => {
    expect(hasLanguageSupport("file.ts")).toBe(true);
    expect(hasLanguageSupport("file.js")).toBe(true);
    expect(hasLanguageSupport("file.py")).toBe(true);
    expect(hasLanguageSupport("file.rs")).toBe(true);
    expect(hasLanguageSupport("file.go")).toBe(true);
    expect(hasLanguageSupport("file.json")).toBe(true);
    expect(hasLanguageSupport("file.css")).toBe(true);
    expect(hasLanguageSupport("file.html")).toBe(true);
    expect(hasLanguageSupport("file.md")).toBe(true);
    expect(hasLanguageSupport("file.yml")).toBe(true);
  });

  it("returns true for aliased extensions", () => {
    expect(hasLanguageSupport("file.tsx")).toBe(true);
    expect(hasLanguageSupport("file.jsx")).toBe(true);
    expect(hasLanguageSupport("file.sh")).toBe(true);
    expect(hasLanguageSupport("file.toml")).toBe(true);
    expect(hasLanguageSupport("file.mjs")).toBe(true);
    expect(hasLanguageSupport("file.pyi")).toBe(true);
  });

  it("returns false for unknown extensions", () => {
    expect(hasLanguageSupport("file.xyz")).toBe(false);
    expect(hasLanguageSupport("file.docx")).toBe(false);
    expect(hasLanguageSupport("file.png")).toBe(false);
    expect(hasLanguageSupport("file.mp3")).toBe(false);
  });

  it("handles files with no dot — uses full name as extension", () => {
    // "Makefile" -> pop() = "Makefile" -> lowercase "makefile" is registered
    expect(hasLanguageSupport("Makefile")).toBe(true);
    // "Dockerfile" is not registered
    expect(hasLanguageSupport("Dockerfile")).toBe(false);
  });

  it("handles case-insensitive extensions", () => {
    expect(hasLanguageSupport("file.TS")).toBe(true);
    expect(hasLanguageSupport("file.PY")).toBe(true);
    expect(hasLanguageSupport("file.JSON")).toBe(true);
  });
});

describe("highlightCode", () => {
  it("returns HTML with hljs spans for known languages", () => {
    const code = 'const x: number = 42;';
    const result = highlightCode(code, "test.ts");
    expect(result).toContain("hljs-");
    expect(result).toContain("span");
  });

  it("highlights Python code", () => {
    const code = 'def hello():\n    print("world")';
    const result = highlightCode(code, "test.py");
    expect(result).toContain("hljs-");
  });

  it("highlights JSON code", () => {
    const code = '{"key": "value", "num": 42}';
    const result = highlightCode(code, "config.json");
    expect(result).toContain("hljs-");
  });

  it("uses auto-detection for unknown extensions", () => {
    const code = 'function test() { return 42; }';
    const result = highlightCode(code, "file.unknown");
    // Should return something (either highlighted or plain)
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });

  it("preserves code content in output", () => {
    const code = 'let message = "hello";';
    const result = highlightCode(code, "test.js");
    // The text content should still be present (inside spans)
    expect(result).toContain("message");
    expect(result).toContain("hello");
  });

  it("handles empty code", () => {
    const result = highlightCode("", "test.ts");
    expect(result).toBe("");
  });

  it("handles alias extensions (tsx -> xml)", () => {
    const code = '<div className="test">Hello</div>';
    const result = highlightCode(code, "component.tsx");
    expect(result).toContain("hljs-");
  });
});
