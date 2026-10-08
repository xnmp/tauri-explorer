import { describe, expect, it } from "vitest";
import type { FileEntry } from "$lib/domain/file";
import { openWithUnavailableReason } from "$lib/domain/open-with";

const file = { kind: "file", path: "/file.txt" } as FileEntry;
const directory = { kind: "directory", path: "/folder" } as FileEntry;
describe("Open with selection and platform availability", () => {
  it("supports one Linux file", () => expect(openWithUnavailableReason([file], "linux")).toBeNull());
  it.each([[], [directory], [file, file]].map(entries => ({ entries })))("explains ineligible selection %#", ({ entries }) => {
    expect(openWithUnavailableReason(entries, "linux")).toBe("Select one regular file to choose an application");
  });
  it.each(["windows", "macos"] as const)("truthfully disables %s", platform => {
    expect(openWithUnavailableReason([file], platform)).toBe("Open with is currently available on Linux");
  });
});
