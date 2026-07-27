import { describe, expect, it, vi } from "vitest";
import {
  buildGitHubIssue,
  createInMemoryRateLimitStore,
  enforceReportLimits,
  processReport,
  validateReport,
} from "../../website/api/report-core.js";

const valid = {
  title: "Explorer freezes 🧊",
  body: "Opening a directory hangs.",
  kind: "bug",
  contact: "",
  version: "1.7.0",
  os: "linux",
  arch: "x86_64",
};

describe("report relay validation", () => {
  it("normalizes a valid report and selects observable GitHub labels", () => {
    const report = validateReport({
      ...valid,
      title: "  Explorer\nfreezes 🧊  ",
      contact: "  @reporter  ",
    });
    expect(report).toEqual({ ...valid, title: "Explorer freezes 🧊", contact: "@reporter" });
    expect(buildGitHubIssue(report)).toMatchObject({
      title: "Explorer freezes 🧊",
      labels: ["user-report", "bug"],
    });
  });

  it("uses the enhancement label for feature requests", () => {
    expect(buildGitHubIssue(validateReport({ ...valid, kind: "feature" })).labels)
      .toEqual(["user-report", "enhancement"]);
  });

  it.each([
    [{ ...valid, title: "" }],
    [{ ...valid, title: "   " }],
    [{ ...valid, title: "x".repeat(121) }],
    [{ ...valid, body: "   " }],
    [{ ...valid, body: "x".repeat(10_000) }],
    [{ ...valid, body: "https://spam.example/path" }],
    [{ ...valid, kind: "question" }],
    [{ ...valid, contact: "x".repeat(101) }],
    [{ ...valid, title: "bad\u0000title" }],
  ])("rejects malformed input with a typed error", (input) => {
    expect(() => validateReport(input)).toThrow(
      expect.objectContaining({ code: "malformed_input" }),
    );
  });

  it("accepts an 8000-character unicode body", () => {
    expect(validateReport({ ...valid, body: "🐛".repeat(4000) }).body).toHaveLength(8000);
  });
});

describe("report relay rate limits", () => {
  it("allows a small burst then blocks the IP", async () => {
    const store = createInMemoryRateLimitStore();
    const now = 1_900_000_000_000;
    for (let count = 0; count < 3; count++) {
      await expect(enforceReportLimits(store, "198.51.100.1", now)).resolves.toBeUndefined();
    }
    await expect(enforceReportLimits(store, "198.51.100.1", now))
      .rejects.toMatchObject({ code: "rate_limited" });
  });

  it("enforces the low hourly ceiling after burst windows pass", async () => {
    const store = createInMemoryRateLimitStore();
    const start = 1_900_000_000_000;
    for (let count = 0; count < 10; count++) {
      await enforceReportLimits(store, "198.51.100.2", start + count * 61_000);
    }
    await expect(enforceReportLimits(store, "198.51.100.2", start + 10 * 61_000))
      .rejects.toMatchObject({ code: "rate_limited" });
  });

  it("returns a distinct daily-cap error", async () => {
    const store = createInMemoryRateLimitStore();
    const now = 1_900_000_000_000;
    for (let count = 0; count < 100; count++) {
      await enforceReportLimits(store, `203.0.113.${count}`, now + count * 100);
    }
    await expect(enforceReportLimits(store, "192.0.2.1", now + 20_000))
      .rejects.toMatchObject({ code: "daily_cap" });
  });

  it("does not call downstream work for a honeypot submission", async () => {
    const createIssue = vi.fn();
    await expect(processReport(
      { ...valid, website: "bot-filled" },
      "198.51.100.3",
      createInMemoryRateLimitStore(),
      createIssue,
    )).resolves.toEqual({ accepted: true, honeypot: true });
    expect(createIssue).not.toHaveBeenCalled();
  });
});
