import { describe, expect, it, vi } from "vitest";
import {
  buildGitHubIssue,
  createInMemoryRateLimitStore,
  createRestRateLimitStore,
  enforceReportLimits,
  processReport,
  validateReport,
} from "../../website/api/report-core.js";
import reportHandler from "../../website/api/report.js";

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
  it.each(["burst", "hour", "day"])(
    "preserves the %s scope returned by the atomic REST store",
    async (scope) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ result: scope }), { status: 200 }),
      );
      const store = createRestRateLimitStore("https://kv.example", "token");
      const entries = [
        { scope: "burst", key: "burst-key", limit: 3, windowMs: 60_000 },
        { scope: "hour", key: "hour-key", limit: 10, windowMs: 3_600_000 },
        { scope: "day", key: "day-key", limit: 100, windowMs: 86_400_000 },
      ];
      await expect(store.consume(entries)).resolves.toBe(scope);
      const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(request.slice(2, 6)).toEqual([3, "burst-key", "hour-key", "day-key"]);
      expect(request.slice(-3)).toEqual(["burst", "hour", "day"]);
      expect(request[1]).toContain("ARGV[#KEYS * 2 + i]");
      fetchMock.mockRestore();
    },
  );

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

describe("report relay HTTP contract", () => {
  function response() {
    const state = { status: 0, headers: new Map<string, string>(), body: undefined as unknown };
    return {
      state,
      status(code: number) { state.status = code; return this; },
      setHeader(name: string, value: string) { state.headers.set(name, value); return this; },
      json(body: unknown) { state.body = body; return this; },
    };
  }

  it("rejects non-POST methods and marks the typed response no-store", async () => {
    const res = response();
    await reportHandler({ method: "GET", headers: {}, socket: {} }, res);
    expect(res.state.status).toBe(405);
    expect(res.state.headers.get("Allow")).toBe("POST");
    expect(res.state.headers.get("Cache-Control")).toBe("no-store");
    expect(res.state.body).toMatchObject({ error: { code: "method_not_allowed" } });
  });

  it("quietly accepts a filled honeypot without a GitHub token", async () => {
    const res = response();
    await reportHandler({
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.50" },
      socket: {},
      body: { website: "spam-bot" },
    }, res);
    expect(res.state.status).toBe(200);
    expect(res.state.body).toEqual({ url: "", number: 0 });
  });
});
