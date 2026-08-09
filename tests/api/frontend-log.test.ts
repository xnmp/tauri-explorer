import { describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("$lib/api/common", () => ({ invoke: invokeMock }));

import { logFrontendDiagnostic } from "$lib/api/frontend-log";

describe("frontend diagnostic logging", () => {
  it("forwards a frontend-only preview failure to the native rolling-log command", () => {
    invokeMock.mockResolvedValue(undefined);
    logFrontendDiagnostic("preview asset image decode failed", {
      path: "C:\\Users\\me\\photo.jpg",
      error: "image decode failed",
    });

    expect(invokeMock).toHaveBeenCalledWith("log_frontend_error", {
      message: '[preview asset image decode failed] {"path":"C:\\\\Users\\\\me\\\\photo.jpg","error":"image decode failed"}',
    });
  });
});
