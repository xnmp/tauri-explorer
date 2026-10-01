import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ native: vi.fn(), browser: vi.fn(), loaded: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.native }));
vi.mock("$lib/api/mock-invoke", () => {
  backend.loaded();
  return { mockInvoke: backend.browser };
});

describe("runtime IPC routing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    backend.native.mockResolvedValue("native result");
    backend.browser.mockResolvedValue("browser result");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads no browser fixtures when importing and invoking in a native window", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const { invoke } = await import("$lib/api/common");
    await expect(invoke("native_command", { path: "/a" })).resolves.toBe("native result");
    expect(backend.native).toHaveBeenCalledWith("native_command", { path: "/a" });
    expect(backend.loaded).not.toHaveBeenCalled();
  });

  it("routes browser requests and detects later native injection", async () => {
    vi.stubGlobal("window", {});
    const { invoke } = await import("$lib/api/common");
    await expect(invoke("first")).resolves.toBe("browser result");
    await expect(invoke("second", { n: 2 })).resolves.toBe("browser result");
    expect(backend.browser).toHaveBeenCalledWith("first");
    expect(backend.browser).toHaveBeenCalledWith("second", { n: 2 });

    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    await expect(invoke("third")).resolves.toBe("native result");
    // Positive detection remains latched, preserving the existing IPC contract.
    vi.stubGlobal("window", {});
    await expect(invoke("fourth")).resolves.toBe("native result");
    expect(backend.native).toHaveBeenCalledWith("fourth");
  });

  it("propagates backend rejections to the API wrapper", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const failure = { kind: "permission_denied", message: "Access denied" };
    backend.native.mockRejectedValue(failure);
    const { invoke } = await import("$lib/api/common");
    await expect(invoke("read_file")).rejects.toBe(failure);
  });
});
