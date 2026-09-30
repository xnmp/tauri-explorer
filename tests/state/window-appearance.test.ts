import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/domain/platform", () => ({ isMac: false, isWindows: true }));
vi.mock("$lib/state/window-backdrop", () => ({ windowsBackdropEffects: () => undefined }));
vi.mock("$lib/state/settings.svelte", () => ({ settingsStore: {} }));
vi.mock("$lib/state/persisted", () => ({ EXPLORER_BG_RGBA_KEY: "bg", loadPersisted: () => null }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ARGS = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=9237";

async function appearance(hooks: boolean) {
  vi.resetModules();
  vi.stubEnv("VITE_E2E_HOOKS", hooks ? "1" : "");
  return (await import("$lib/state/window-appearance")).explorerWindowAppearance;
}

describe("native child window environment", () => {
  it("keeps the default browser environment without an attach-build injection", async () => {
    const explorerWindowAppearance = await appearance(true);
    vi.stubGlobal("window", {});
    expect(explorerWindowAppearance("Explorer")).not.toHaveProperty("additionalBrowserArgs");
  });

  it("preserves the exact injected main-window environment for every child", async () => {
    const explorerWindowAppearance = await appearance(true);
    vi.stubGlobal("window", { __E2E_WEBVIEW_BROWSER_ARGS__: ARGS });
    expect(explorerWindowAppearance("Fresh child")).toMatchObject({ additionalBrowserArgs: ARGS });
  });

  it("never forwards an injected environment in a build without hooks", async () => {
    const explorerWindowAppearance = await appearance(false);
    vi.stubGlobal("window", { __E2E_WEBVIEW_BROWSER_ARGS__: ARGS });
    expect(explorerWindowAppearance("Fresh child")).not.toHaveProperty("additionalBrowserArgs");
  });
});
