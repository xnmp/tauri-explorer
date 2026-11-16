import { describe, it, expect } from "vitest";
import { dedupeFrontendCrash } from "../../src/lib/domain/crash-report";

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

describe("crash report titles and drafts (#1684)", () => {
  it("titles a report after the panic line", async () => {
    const { crashReportTitle } = await import("../../src/lib/domain/crash-report-draft");
    expect(crashReportTitle("os: linux\npanic: index out of bounds\nlocation: x")).toBe(
      "Crash: index out of bounds",
    );
    expect(crashReportTitle("no panic line at all")).toBe("Crash: unknown error");
    expect(crashReportTitle("")).toBe("Crash: unknown error");
    const long = crashReportTitle(`panic: ${"x".repeat(500)}`);
    expect(long.length).toBeLessThanOrEqual("Crash: ".length + 80);
    expect(long.endsWith("…")).toBe(true);
    expect(crashReportTitle("panic: a\tb\r\nc")).toBe("Crash: a b");
  });

  it("fills an empty draft but never overwrites the reporter's own", async () => {
    const { crashDraftUpdate } = await import("../../src/lib/domain/crash-report-draft");
    expect(crashDraftUpdate({ title: "  " }, "panic: boom")).toEqual({ title: "Crash: boom", kind: "bug" });
    expect(crashDraftUpdate({ title: "My draft" }, "panic: boom")).toBeNull();
  });
});
