/**
 * "Hide auxiliary info in the preview pane" setting (#494).
 *
 * The user-visible behaviour (the preview pane dropping its name/type badge/
 * size/modified chrome) is asserted end-to-end in
 * e2e/preview-auxiliary-info.spec.ts. What this suite pins down is the seam
 * PreviewPane and the command palette both read from: the setting must default
 * to ON (so existing users see no change), must survive a restart, and must be
 * reachable as a palette toggle whose checkmark reflects the live value.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readConfigFileMock = vi.fn();
const writeConfigQueuedMock = vi.fn();

vi.mock("$lib/api/config", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    readConfigFile: (...args: unknown[]) => readConfigFileMock(...args),
  };
});

vi.mock("$lib/state/persisted", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    writeConfigQueued: (...args: unknown[]) => writeConfigQueuedMock(...args),
  };
});

async function freshModule() {
  vi.resetModules();
  return await import("$lib/state/settings.svelte");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  readConfigFileMock.mockResolvedValue({ ok: false, error: "not found" });
});

describe("preview auxiliary info setting (#494)", () => {
  it("is on by default, so the preview pane keeps showing its metadata", async () => {
    const { settingsStore } = await freshModule();
    expect(settingsStore.showPreviewInfo).toBe(true);
  });

  it("turning it off persists, so the preview stays minimal across a restart", async () => {
    const { settingsStore } = await freshModule();

    settingsStore.togglePreviewInfo();

    expect(settingsStore.showPreviewInfo).toBe(false);
    expect(JSON.parse(localStorage.getItem("explorer-settings")!).showPreviewInfo).toBe(false);

    // Restart: a fresh store rehydrates from what was persisted.
    const reloaded = await freshModule();
    expect(reloaded.settingsStore.showPreviewInfo).toBe(false);
  });

  it("a persisted value from the config file wins over the default", async () => {
    readConfigFileMock.mockResolvedValue({
      ok: true,
      data: JSON.stringify({ showPreviewInfo: false }),
    });
    const { settingsStore } = await freshModule();

    await settingsStore.init();

    expect(settingsStore.showPreviewInfo).toBe(false);
  });

  it("is reachable from the command palette as a toggle that mirrors the live value", async () => {
    const { settingsStore, generateToggleCommands } = await freshModule();

    const command = generateToggleCommands().find((c) => c.id === "view.togglePreviewInfo");
    expect(command, "no palette command registered for the preview info setting").toBeDefined();
    expect(command!.label).toMatch(/preview info/i);

    // The palette renders a checkmark from toggleState() — it must track the
    // setting, not a snapshot taken at registration time.
    expect(command!.toggleState?.()).toBe(true);

    command!.handler();
    expect(settingsStore.showPreviewInfo).toBe(false);
    expect(command!.toggleState?.()).toBe(false);

    command!.handler();
    expect(settingsStore.showPreviewInfo).toBe(true);
    expect(command!.toggleState?.()).toBe(true);
  });
});
