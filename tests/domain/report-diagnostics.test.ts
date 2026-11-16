import { describe, expect, it } from "vitest";
import {
  budgetAfter,
  fitTextForReport,
  MAX_REPORT_DIAGNOSTIC_UNITS,
  MIN_REPORT_DIAGNOSTIC_UNITS,
  REPORT_DIAGNOSTIC_WRAPPER_UNITS,
  REPORT_TEXT_TRUNCATED,
  reportDiagnosticsBudget,
  sectionBudget,
} from "$lib/domain/report-diagnostics";

const crash = [
  "tauri-explorer 1.25.2 crash report",
  "os: Arch Linux (x86_64)",
  "panic: index out of bounds",
  "location: src/files/dir_listing.rs:42:9",
  "",
  "backtrace:",
  ...Array.from({ length: 400 }, (_, n) => `  ${n}: tauri_explorer_lib::files::frame_${n}`),
].join("\n");

describe("reportDiagnosticsBudget", () => {
  it("leaves the room the relay body has after the reporter's text", () => {
    expect(reportDiagnosticsBudget("")).toBe(8500 - 600);
    expect(reportDiagnosticsBudget("  d  ".repeat(1), "@me")).toBe(8500 - 600 - 1 - 3);
    expect(reportDiagnosticsBudget("d".repeat(8000), "c".repeat(100))).toBe(0);
  });

  it("caps each section and charges its wrapper", () => {
    expect(sectionBudget(100_000)).toBe(MAX_REPORT_DIAGNOSTIC_UNITS);
    expect(sectionBudget(1000)).toBe(1000 - REPORT_DIAGNOSTIC_WRAPPER_UNITS);
    expect(sectionBudget(10)).toBe(0);
    expect(budgetAfter(1000, "x".repeat(300))).toBe(1000 - 300 - REPORT_DIAGNOSTIC_WRAPPER_UNITS);
    expect(budgetAfter(1000, "")).toBe(1000);
    expect(budgetAfter(50, "x".repeat(300))).toBe(0);
  });
});

describe("fitTextForReport", () => {
  it("returns short text unchanged and keeps the head of long text", () => {
    expect(fitTextForReport("  panic: boom  ", 1000)).toBe("panic: boom");
    const fitted = fitTextForReport(crash, 1000);
    expect(fitted.length).toBeLessThanOrEqual(1000);
    expect(fitted.startsWith("tauri-explorer 1.25.2 crash report\nos: Arch Linux")).toBe(true);
    expect(fitted).toContain("panic: index out of bounds");
    expect(fitted).toContain("  0: tauri_explorer_lib::files::frame_0");
    expect(fitted.endsWith(`\n${REPORT_TEXT_TRUNCATED}`)).toBe(true);
    // Whole lines only: every kept line is a line of the original.
    const original = new Set(crash.split("\n"));
    for (const line of fitted.split("\n").slice(0, -1)) expect(original.has(line)).toBe(true);
  });

  it("omits a section the native side would drop, and empty input", () => {
    expect(fitTextForReport(crash, MIN_REPORT_DIAGNOSTIC_UNITS - 1)).toBe("");
    expect(fitTextForReport("   \n  ", 5000)).toBe("");
  });

  it("cuts a single overlong line without splitting a surrogate pair", () => {
    const fitted = fitTextForReport("🐛".repeat(5000), 500);
    expect(fitted.length).toBeLessThanOrEqual(500);
    expect(fitted).not.toMatch(/[\uD800-\uDBFF]\n/);
    expect(fitted.endsWith(REPORT_TEXT_TRUNCATED)).toBe(true);
  });
});
