import { describe, it, expect } from "vitest";
import {
  AI_FILTER_IDLE, AI_FILTER_MAX_BYTES, AI_FILTER_MAX_ENTRIES, aiFilterOwnsListing, aiFilterStatus,
  beginAiFilter, buildAiFilterPrompt, entryLine, isAiFilterKey, normalizeAiFilterQuery, parseAiFilterResponse, settleAiFilter,
} from "$lib/domain/ai-filter";
import type { FileEntry } from "$lib/domain/file";

const file = (name: string, size = 10, modified = "2026-11-02T09:30:00"): FileEntry => ({ name, path: `/d/${name}`, kind: "file", size, modified });
const dir = (name: string): FileEntry => ({ name, path: `/d/${name}`, kind: "directory", size: 0, modified: "2026-11-01T08:00:00" });
const now = new Date("2026-11-04T12:00:00");

describe("buildAiFilterPrompt", () => {
  it("describes the request, current time and every entry compactly", () => {
    const prompt = buildAiFilterPrompt("invoices from last 3 days", "/d", [dir("Archive"), file("Invoice-41.PDF", 1234)], now);
    expect(prompt.input).toContain("Request: invoices from last 3 days");
    expect(prompt.input).toContain("Current time: 2026-11-04 12:00");
    expect(prompt.input).toContain("Wednesday");
    expect(prompt.input).toContain("Folder: /d");
    expect(prompt.input).toContain("Entries (2):");
    expect(prompt.input).toContain("d\tArchive\t\t-\t2026-11-01 08:00");
    expect(prompt.input).toContain("f\tInvoice-41.PDF\tpdf\t1234\t2026-11-02 09:30");
    expect(prompt.sent).toEqual(["Archive", "Invoice-41.PDF"]);
    expect(prompt.truncated).toBe(false);
    expect(prompt.instructions).toMatch(/JSON/);
  });

  it("caps the entry count and says the listing was truncated", () => {
    const entries = Array.from({ length: AI_FILTER_MAX_ENTRIES + 5 }, (_, i) => file(`f${i}`));
    const prompt = buildAiFilterPrompt("x", "/d", entries, now);
    expect(prompt.sent).toHaveLength(AI_FILTER_MAX_ENTRIES);
    expect(prompt.total).toBe(AI_FILTER_MAX_ENTRIES + 5);
    expect(prompt.truncated).toBe(true);
    expect(prompt.input).toContain(`listing truncated: ${AI_FILTER_MAX_ENTRIES} of ${AI_FILTER_MAX_ENTRIES + 5} shown`);
  });

  it("keeps instructions plus input within the native 64 KiB request limit", () => {
    const long = "é".repeat(120);
    const entries = Array.from({ length: 1500 }, (_, i) => file(`${long}-${i}.txt`));
    const prompt = buildAiFilterPrompt("q".repeat(1000), "/d", entries, now);
    const encoder = new TextEncoder();
    const size = encoder.encode(prompt.instructions).length + encoder.encode(prompt.input).length;
    expect(size).toBeLessThanOrEqual(AI_FILTER_MAX_BYTES);
    expect(size).toBeLessThanOrEqual(64 * 1024);
    expect(prompt.truncated).toBe(true);
    expect(prompt.sent.length).toBeGreaterThan(0);
  });

  it("keeps the line format intact for names containing tabs or newlines", () => {
    expect(entryLine(file("a\tb\nc"))).toBe("f\ta b c\t\t10\t2026-11-02 09:30");
  });

  it("normalizes control characters and bounds the query", () => {
    expect(normalizeAiFilterQuery("  big\u0007files \n")).toBe("big files");
    expect([...normalizeAiFilterQuery("x".repeat(900))]).toHaveLength(500);
  });
});

describe("parseAiFilterResponse", () => {
  const sent = ["Invoice.pdf", "notes.txt", "Photo.JPG", "photo.jpg"];

  it("accepts the documented object shape and drops unknown names", () => {
    expect(parseAiFilterResponse('{"names":["Invoice.pdf","ghost.doc"]}', sent)).toEqual({ ok: true, names: ["Invoice.pdf"], ignored: 1 });
  });

  it("accepts a bare array, code fences and surrounding prose", () => {
    expect(parseAiFilterResponse('["notes.txt"]', sent)).toMatchObject({ ok: true, names: ["notes.txt"] });
    expect(parseAiFilterResponse('```json\n{"names":["notes.txt"]}\n```', sent)).toMatchObject({ ok: true, names: ["notes.txt"] });
    expect(parseAiFilterResponse('Here you go: {"names":["notes.txt"]} hope it helps', sent)).toMatchObject({ ok: true, names: ["notes.txt"] });
  });

  it("matches case-insensitively only when that is unambiguous", () => {
    expect(parseAiFilterResponse('{"names":["invoice.PDF"]}', sent)).toMatchObject({ names: ["Invoice.pdf"], ignored: 0 });
    // Photo.JPG and photo.jpg differ only by case: an inexact spelling is ambiguous.
    expect(parseAiFilterResponse('{"names":["PHOTO.jpg"]}', sent)).toMatchObject({ names: [], ignored: 1 });
    expect(parseAiFilterResponse('{"names":["photo.jpg"]}', sent)).toMatchObject({ names: ["photo.jpg"] });
  });

  it("collapses duplicates and ignores non-string items", () => {
    expect(parseAiFilterResponse('{"names":["notes.txt","notes.txt",3,null]}', sent)).toEqual({ ok: true, names: ["notes.txt"], ignored: 2 });
  });

  it("reports an error for replies without a names list", () => {
    expect(parseAiFilterResponse("I could not find anything.", sent).ok).toBe(false);
    expect(parseAiFilterResponse('{"matches":["notes.txt"]}', sent).ok).toBe(false);
  });

  it("treats an empty list as a valid no-match result", () => {
    expect(parseAiFilterResponse('{"names":[]}', sent)).toEqual({ ok: true, names: [], ignored: 0 });
  });
});

describe("AI filter state machine", () => {
  const target = { requestId: "r1", query: "invoices", path: "/d" };
  const applied = { ok: true as const, names: ["a"], sent: 3, total: 3, truncated: false, ignored: 0 };

  it("applies a result for the request and directory that issued it", () => {
    const next = settleAiFilter(beginAiFilter(target), "r1", "/d", applied);
    expect(next.kind).toBe("applied");
    expect(next.kind === "applied" && [...next.names]).toEqual(["a"]);
    expect(aiFilterOwnsListing(next)).toBe(true);
  });

  it("drops superseded, cleared or navigated-away results by identity", () => {
    const loading = beginAiFilter(target);
    expect(settleAiFilter(loading, "r0", "/d", applied)).toBe(loading);
    expect(settleAiFilter(loading, "r1", "/elsewhere", applied)).toBe(loading);
    expect(settleAiFilter(AI_FILTER_IDLE, "r1", "/d", applied)).toBe(AI_FILTER_IDLE);
  });

  it("settles failures into an error that no longer owns the listing", () => {
    const next = settleAiFilter(beginAiFilter(target), "r1", "/d", { ok: false, message: "boom" });
    expect(next).toMatchObject({ kind: "error", message: "boom", query: "invoices" });
    expect(aiFilterOwnsListing(next)).toBe(false);
  });

  it("describes each state for the status line", () => {
    expect(aiFilterStatus(AI_FILTER_IDLE)).toBeNull();
    expect(aiFilterStatus(beginAiFilter(target))).toMatch(/Esc to cancel/);
    expect(aiFilterStatus(settleAiFilter(beginAiFilter(target), "r1", "/d", applied))).toBe("1 item matches · Esc to clear");
    expect(aiFilterStatus(settleAiFilter(beginAiFilter(target), "r1", "/d", { ...applied, names: [], sent: 2000, total: 2400, truncated: true })))
      .toBe("No items match (AI saw the first 2000 of 2400) · Esc to clear");
  });
});

describe("isAiFilterKey (#1522)", () => {
  const key = (init: { key?: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altGraph?: boolean; isComposing?: boolean }) => ({
    key: init.key ?? "Enter", altKey: !!init.altKey, ctrlKey: !!init.ctrlKey, metaKey: !!init.metaKey, shiftKey: !!init.shiftKey,
    isComposing: !!init.isComposing, getModifierState: (name: string) => name === "AltGraph" && !!init.altGraph,
  });

  it("accepts Alt+Enter", () => {
    expect(isAiFilterKey(key({ altKey: true }))).toBe(true);
  });

  it("accepts a right Alt that the keyboard layout reports as AltGraph", () => {
    // Linux layouts commonly map right Alt to ISO_Level3_Shift: the webview
    // then reports altKey=false with the AltGraph modifier, and the chord
    // used to fall through as a plain Enter that nothing handles.
    expect(isAiFilterKey(key({ altGraph: true }))).toBe(true);
    // Windows reports AltGr as Ctrl+Alt plus AltGraph.
    expect(isAiFilterKey(key({ altGraph: true, altKey: true, ctrlKey: true }))).toBe(true);
  });

  it("rejects plain Enter, other chords, other keys and IME composition", () => {
    expect(isAiFilterKey(key({}))).toBe(false);
    expect(isAiFilterKey(key({ altKey: true, ctrlKey: true }))).toBe(false);
    expect(isAiFilterKey(key({ altKey: true, shiftKey: true }))).toBe(false);
    expect(isAiFilterKey(key({ altKey: true, metaKey: true }))).toBe(false);
    expect(isAiFilterKey(key({ key: "a", altKey: true }))).toBe(false);
    expect(isAiFilterKey(key({ altKey: true, isComposing: true }))).toBe(false);
  });
});
