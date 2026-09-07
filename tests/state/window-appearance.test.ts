import { afterEach, describe, expect, it, vi } from "vitest";
import { explorerWindowAppearance } from "$lib/state/window-appearance";

vi.mock("$lib/domain/platform", () => ({ isMac: false, isWindows: true }));
vi.mock("$lib/state/window-backdrop", () => ({ windowsBackdropEffects: () => undefined }));
vi.mock("$lib/state/settings.svelte", () => ({ settingsStore: {} }));
vi.mock("$lib/state/persisted", () => ({ EXPLORER_BG_RGBA_KEY: "bg", loadPersisted: () => null }));
afterEach(() => vi.unstubAllGlobals());

describe("native child window environment", () => {
  it("keeps the default browser environment without an attach-build injection", () => {
    vi.stubGlobal("window", {});
    expect(explorerWindowAppearance("Explorer")).not.toHaveProperty("additionalBrowserArgs");
  });

  it("preserves the exact injected main-window environment for every child", () => {
    const args = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9237";
    vi.stubGlobal("window", { __E2E_WEBVIEW_BROWSER_ARGS__: args });
    expect(explorerWindowAppearance("Fresh child")).toMatchObject({ additionalBrowserArgs: args });
  });
});
