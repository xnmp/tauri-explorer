import { describe, expect, it } from "vitest";
import { userReportFallbackUrl } from "$lib/domain/user-report";

describe("userReportFallbackUrl", () => {
  it.each([
    ["bug" as const, "bug"],
    ["feature" as const, "enhancement"],
  ])("preserves a %s report in the matching GitHub form", (kind, label) => {
    const fallback = userReportFallbackUrl({
      kind,
      title: "Emoji 🐛\nignored",
      body: "It breaks with café paths.",
      contact: "@reporter",
    });
    expect(fallback).not.toBeNull();
    const url = new URL(
      fallback!,
    );

    expect(url.origin + url.pathname).toBe(
      "https://github.com/xnmp/tauri-explorer/issues/new",
    );
    expect(url.searchParams.get("title")).toBe("Emoji 🐛 ignored");
    expect(url.searchParams.get("body")).toContain("It breaks with café paths.");
    expect(url.searchParams.get("body")).toContain("How to reach me: @reporter");
    expect(url.searchParams.get("labels")).toBe(label);
  });

  it("omits contact when none was provided and strips control characters", () => {
    const fallback = userReportFallbackUrl({
      kind: "bug",
      title: "Broken\u0000 title",
      body: "A\u0007 description",
    });
    expect(fallback).not.toBeNull();
    const url = new URL(
      fallback!,
    );

    expect(url.searchParams.get("title")).toBe("Broken title");
    expect(url.searchParams.get("body")).toBe("A description");
    expect(url.searchParams.get("body")).not.toContain("How to reach me");
  });

  it("refuses a max-length unicode draft that cannot fit without data loss", () => {
    const fallback = userReportFallbackUrl({
      kind: "bug",
      title: "Unicode report 🐛",
      body: "🐛".repeat(4000),
      contact: "@reporter",
    });

    expect(fallback).toBeNull();
  });

  it("keeps every generated fallback URL under the browser-safe ceiling", () => {
    const fallback = userReportFallbackUrl({
      kind: "feature",
      title: "Unicode feature",
      body: "🐛".repeat(450),
    });

    expect(fallback).not.toBeNull();
    expect(fallback!.length).toBeLessThanOrEqual(6000);
  });
});
