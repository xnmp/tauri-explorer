import { describe, it, expect } from "vitest";
import {
  dedupeFrontendCrash,
  recentLogsSection,
  RECENT_LOGS_HEADING,
} from "../../src/lib/domain/crash-report";

describe("dedupeFrontendCrash", () => {
  it("records a first-seen message and remembers it", () => {
    const r = dedupeFrontendCrash(new Set(), "boom");
    expect(r.record).toBe(true);
    expect(r.seen.has("boom")).toBe(true);
  });

  it("suppresses an identical message already seen this session", () => {
    const seen = new Set(["boom"]);
    const r = dedupeFrontendCrash(seen, "boom");
    expect(r.record).toBe(false);
  });

  it("treats whitespace-only differences as the same message", () => {
    const first = dedupeFrontendCrash(new Set(), "  boom  ");
    const second = dedupeFrontendCrash(first.seen, "boom");
    expect(second.record).toBe(false);
  });

  it("records distinct messages independently", () => {
    const first = dedupeFrontendCrash(new Set(), "a");
    const second = dedupeFrontendCrash(first.seen, "b");
    expect(second.record).toBe(true);
    expect(second.seen.size).toBe(2);
  });

  it("does not mutate the input set (immutable in/out)", () => {
    const input = new Set<string>();
    const r = dedupeFrontendCrash(input, "boom");
    expect(input.size).toBe(0);
    expect(r.seen).not.toBe(input);
  });

  it("handles an empty message", () => {
    const first = dedupeFrontendCrash(new Set(), "");
    expect(first.record).toBe(true);
    const second = dedupeFrontendCrash(first.seen, "   ");
    expect(second.record).toBe(false);
  });
});

describe("recentLogsSection", () => {
  it("returns empty string for empty or whitespace input", () => {
    expect(recentLogsSection("", 1000)).toBe("");
    expect(recentLogsSection("   \n  ", 1000)).toBe("");
  });

  it("wraps the tail in a fenced markdown section", () => {
    const section = recentLogsSection("line one\nline two", 1000);
    expect(section).toContain(RECENT_LOGS_HEADING);
    expect(section).toContain("```");
    expect(section).toContain("line one");
    expect(section).toContain("line two");
  });

  it("drops the oldest lines first to fit the budget", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `log line ${i}`);
    const section = recentLogsSection(lines.join("\n"), 200);
    expect(section.length).toBeLessThanOrEqual(200);
    // The most recent line survives; an early one is trimmed away.
    expect(section).toContain("log line 49");
    expect(section).not.toContain("log line 0\n");
  });

  it("keeps the whole section within maxChars", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `x${i}`.repeat(4));
    const section = recentLogsSection(lines.join("\n"), 300);
    expect(section.length).toBeLessThanOrEqual(300);
  });

  it("hard-truncates a single over-long line", () => {
    const oneHugeLine = "a".repeat(5000);
    const section = recentLogsSection(oneHugeLine, 100);
    expect(section.length).toBeLessThanOrEqual(100);
    expect(section).toContain(RECENT_LOGS_HEADING);
  });
});
