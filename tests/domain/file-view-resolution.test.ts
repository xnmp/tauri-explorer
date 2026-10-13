import { describe, expect, it } from "vitest";
import { resolveFileView, FILE_VIEW_ELIGIBILITY_WAIT_MS, type FileViewEligibility } from "$lib/domain/file-view-resolution";

const provider = (id: string, eligibility: FileViewEligibility) => ({ id, eligibility });

describe("file view first-paint resolution", () => {
  it("shows built-in with no providers or an unregistered preference", () => {
    expect(resolveFileView([], "trace.view", 0)).toEqual({ kind: "builtin" });
    expect(resolveFileView([provider("other.view", true)], "trace.view", 0)).toEqual({ kind: "builtin" });
  });

  it.each([null, undefined, ""])("honors built-in preference %s despite pending providers", (preference) => {
    expect(resolveFileView([provider("trace.view", "pending")], preference, 0)).toEqual({ kind: "builtin" });
  });

  it.each([0, 399, 400, Number.MAX_VALUE, Infinity])("preserves boolean behavior at %sms", (elapsed) => {
    expect(resolveFileView([provider("trace.view", true)], "trace.view", elapsed)).toEqual({ kind: "plugin", id: "trace.view" });
    expect(resolveFileView([provider("trace.view", false)], "trace.view", elapsed)).toEqual({ kind: "builtin" });
  });

  it("holds until the boundary, then falls back even if the provider never answers", () => {
    const providers = [provider("trace.view", "pending")];
    expect(resolveFileView(providers, "trace.view", FILE_VIEW_ELIGIBILITY_WAIT_MS - 1)).toEqual({ kind: "hold" });
    expect(resolveFileView(providers, "trace.view", FILE_VIEW_ELIGIBILITY_WAIT_MS)).toEqual({ kind: "builtin" });
    expect(resolveFileView(providers, "trace.view", Infinity)).toEqual({ kind: "builtin" });
  });

  it("switches to the preferred view on a late answer", () => {
    expect(resolveFileView([provider("trace.view", true)], "trace.view", 10_000)).toEqual({ kind: "plugin", id: "trace.view" });
  });

  it.each([false, true, "pending"] as const)("ignores other pending providers when preference answers %s", (answer) => {
    const providers = [provider("one.view", "pending"), provider("two.view", "pending"), provider("chosen.view", answer)];
    expect(resolveFileView(providers, "chosen.view", 0)).toEqual(answer === true
      ? { kind: "plugin", id: "chosen.view" } : answer === "pending" ? { kind: "hold" } : { kind: "builtin" });
    expect(resolveFileView(providers, "chosen.view", 400)).toEqual(answer === true
      ? { kind: "plugin", id: "chosen.view" } : { kind: "builtin" });
  });

  it.each([NaN, Infinity, Number.MAX_VALUE])("fails open for invalid/large elapsed %s", (elapsed) => {
    expect(resolveFileView([provider("trace.view", "pending")], "trace.view", elapsed)).toEqual({ kind: "builtin" });
  });
});
