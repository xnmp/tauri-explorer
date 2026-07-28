import { describe, expect, it, vi } from "vitest";
import {
  buildGitHubIssue,
  createInMemoryRateLimitStore,
  createRestRateLimitStore,
  enforceReportLimits,
  processReport,
  validateReport,
} from "../../website/api/report-core.js";
import reportHandler, { reporterIp } from "../../website/api/report.js";

const valid = {
  title: "Explorer freezes 🧊",
  body: "Opening a directory hangs.",
  kind: "bug",
  contact: "",
  version: "1.7.0",
  os: "linux",
  arch: "x86_64",
};
const pngData = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]).toString("base64");

describe("report relay validation", () => {
  it("normalizes a valid report and selects observable GitHub labels", () => {
    const report = validateReport({
      ...valid,
      title: "  Explorer\nfreezes 🧊  ",
      contact: "  @reporter  ",
    });
    expect(report).toEqual({
      ...valid,
      title: "Explorer freezes 🧊",
      contact: "@reporter",
      attachments: [],
    });
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

  it("decodes supported image attachments for the hosting boundary", () => {
    const report = validateReport({
      ...valid,
      attachments: [{ name: " screenshot (1).png ", mediaType: "image/png", data: pngData }],
    });

    expect(report.attachments).toHaveLength(1);
    expect(report.attachments[0]).toMatchObject({
      name: "screenshot (1).png",
      mediaType: "image/png",
    });
    expect([...report.attachments[0].bytes]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ]);
  });

  it.each([
    [{ name: "vector.svg", mediaType: "image/svg+xml", data: pngData }],
    [{ name: "empty.png", mediaType: "image/png", data: "" }],
    [{ name: "fake.png", mediaType: "image/png", data: Buffer.from("not png").toString("base64") }],
    [{ name: "bad.png", mediaType: "image/png", data: "%%%not-base64%%%" }],
  ])("rejects malformed image attachments before downstream work", (attachment) => {
    expect(() => validateReport({ ...valid, attachments: [attachment] })).toThrow(
      expect.objectContaining({ code: "malformed_input" }),
    );
  });

  it("rejects excessive attachment counts and decoded bytes", () => {
    expect(() => validateReport({
      ...valid,
      attachments: Array.from({ length: 4 }, (_, index) => ({
        name: `${index}.png`,
        mediaType: "image/png",
        data: pngData,
      })),
    })).toThrow(expect.objectContaining({ code: "malformed_input" }));
    expect(() => validateReport({
      ...valid,
      attachments: [{
        name: "huge.png",
        mediaType: "image/png",
        data: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(2 * 1024 * 1024),
        ]).toString("base64"),
      }],
    })).toThrow(expect.objectContaining({ code: "malformed_input" }));
  });
});

describe("report attachment delivery", () => {
  it("hosts each image and creates an issue that renders the returned public URLs", async () => {
    const createIssue = vi.fn().mockResolvedValue({ url: "https://github.test/issues/1", number: 1 });
    const attachmentStore = {
      upload: vi.fn()
        .mockResolvedValueOnce("https://blob.test/first.png")
        .mockResolvedValueOnce("https://blob.test/second.jpg"),
      remove: vi.fn(),
    };

    await expect(processReport(
      {
        ...valid,
        attachments: [
          { name: "first [shot].png", mediaType: "image/png", data: pngData },
          {
            name: "second.jpg",
            mediaType: "image/jpeg",
            data: Buffer.from([0xff, 0xd8, 0xff, 1]).toString("base64"),
          },
        ],
      },
      "198.51.100.8",
      createInMemoryRateLimitStore(),
      createIssue,
      attachmentStore,
    )).resolves.toEqual({ url: "https://github.test/issues/1", number: 1 });

    expect(attachmentStore.upload).toHaveBeenCalledTimes(2);
    expect(attachmentStore.upload.mock.calls[0][0]).toMatchObject({
      name: "first [shot].png",
      mediaType: "image/png",
    });
    expect(createIssue).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining(
        "## Attachments\n\n![first \\[shot\\].png](https://blob.test/first.png)"
      ),
    }));
    expect(createIssue.mock.calls[0][0].body).toContain(
      "![second.jpg](https://blob.test/second.jpg)",
    );
  });

  it("keeps the existing issue body and skips hosting when no images were attached", async () => {
    const createIssue = vi.fn().mockResolvedValue({ url: "https://github.test/issues/2", number: 2 });
    const attachmentStore = { upload: vi.fn(), remove: vi.fn() };

    await processReport(
      valid,
      "198.51.100.9",
      createInMemoryRateLimitStore(),
      createIssue,
      attachmentStore,
    );

    expect(attachmentStore.upload).not.toHaveBeenCalled();
    expect(createIssue.mock.calls[0][0].body).toBe(valid.body);
  });

  it("removes hosted blobs and does not leave a text-only issue when delivery fails", async () => {
    const createIssue = vi.fn().mockRejectedValue(new Error("GitHub unavailable"));
    const attachmentStore = {
      upload: vi.fn().mockResolvedValue("https://blob.test/orphan.png"),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    await expect(processReport(
      { ...valid, attachments: [{ name: "shot.png", mediaType: "image/png", data: pngData }] },
      "198.51.100.10",
      createInMemoryRateLimitStore(),
      createIssue,
      attachmentStore,
    )).rejects.toThrow("GitHub unavailable");
    expect(attachmentStore.remove).toHaveBeenCalledWith(["https://blob.test/orphan.png"]);
  });

  it("cleans up earlier blobs when a later image upload fails", async () => {
    const createIssue = vi.fn();
    const attachmentStore = {
      upload: vi.fn()
        .mockResolvedValueOnce("https://blob.test/first.png")
        .mockRejectedValueOnce(new Error("Blob unavailable")),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    await expect(processReport(
      {
        ...valid,
        attachments: [
          { name: "first.png", mediaType: "image/png", data: pngData },
          { name: "second.png", mediaType: "image/png", data: pngData },
        ],
      },
      "198.51.100.11",
      createInMemoryRateLimitStore(),
      createIssue,
      attachmentStore,
    )).rejects.toThrow("Blob unavailable");
    expect(createIssue).not.toHaveBeenCalled();
    expect(attachmentStore.remove).toHaveBeenCalledWith(["https://blob.test/first.png"]);
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

  it("does not spend the global cap on burst-blocked attempts", async () => {
    const store = createInMemoryRateLimitStore();
    const now = 1_900_000_000_000;
    for (let count = 0; count < 3; count++) {
      await enforceReportLimits(store, "198.51.100.9", now);
    }
    for (let count = 0; count < 150; count++) {
      await expect(enforceReportLimits(store, "198.51.100.9", now))
        .rejects.toMatchObject({ code: "rate_limited" });
    }
    for (let count = 0; count < 97; count++) {
      await enforceReportLimits(store, `203.0.113.${count}`, now + count * 100);
    }
    await expect(enforceReportLimits(store, "192.0.2.99", now + 20_000))
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
    const state = {
      status: 0,
      headers: new Map<string, string>(),
      body: undefined as unknown,
      ended: false,
    };
    return {
      state,
      status(code: number) { state.status = code; return this; },
      setHeader(name: string, value: string) { state.headers.set(name, value); return this; },
      json(body: unknown) { state.body = body; return this; },
      end() { state.ended = true; return this; },
    };
  }

  it("prefers Vercel's trusted IP and otherwise uses the proxy-appended XFF tail", () => {
    expect(reporterIp({
      "x-vercel-forwarded-for": "203.0.113.40",
      "x-forwarded-for": "198.51.100.1, 192.0.2.10",
    })).toBe("203.0.113.40");
    expect(reporterIp({
      "x-forwarded-for": "client-controlled, 192.0.2.10",
    })).toBe("192.0.2.10");
  });

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
    expect(res.state.status).toBe(204);
    expect(res.state.ended).toBe(true);
    expect(res.state.body).toBeUndefined();
  });
});
