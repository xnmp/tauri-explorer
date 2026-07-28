import { describe, expect, it } from "vitest";
import {
  MAX_USER_REPORT_ATTACHMENT_BYTES,
  MAX_USER_REPORT_ATTACHMENTS_BYTES,
  userReportFallbackUrl,
  validateUserReportAttachmentFiles,
} from "$lib/domain/user-report";

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

describe("validateUserReportAttachmentFiles", () => {
  const image = (name: string, type: string, size: number) => ({ name, type, size });

  it("accepts multiple supported images within the count and byte budgets", () => {
    expect(validateUserReportAttachmentFiles([
      image("first.png", "image/png", 200_000),
      image("second.jpg", "image/jpeg", 300_000),
      image("third.gif", "image/gif", 400_000),
    ])).toBeNull();
  });

  it.each([
    [[image("vector.svg", "image/svg+xml", 100)], "PNG, JPEG, or GIF"],
    [[image("empty.png", "image/png", 0)], "empty"],
    [[image("large.png", "image/png", MAX_USER_REPORT_ATTACHMENT_BYTES + 1)], "2 MiB"],
    [[
      image("one.png", "image/png", 1),
      image("two.png", "image/png", 1),
      image("three.png", "image/png", 1),
      image("four.png", "image/png", 1),
    ], "up to 3"],
    [[
      image("one.png", "image/png", MAX_USER_REPORT_ATTACHMENTS_BYTES / 2 + 1),
      image("two.png", "image/png", MAX_USER_REPORT_ATTACHMENTS_BYTES / 2),
    ], "3 MiB"],
  ])("returns an actionable reason for invalid selections", (files, message) => {
    expect(validateUserReportAttachmentFiles(files)).toContain(message);
  });

  it("accounts for attachments that are already selected", () => {
    expect(validateUserReportAttachmentFiles(
      [image("new.png", "image/png", 2)],
      { count: 3, bytes: 100 },
    )).toContain("up to 3");
    expect(validateUserReportAttachmentFiles(
      [image("new.png", "image/png", 2)],
      { count: 1, bytes: MAX_USER_REPORT_ATTACHMENTS_BYTES - 1 },
    )).toContain("3 MiB");
  });
});
