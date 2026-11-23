/**
 * Update commands in the palette (#1901): "Check for Updates" requests an
 * immediate check (the host bypasses the daily throttle when the request
 * counter moves), and a settings toggle flips the persisted auto-update setting.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settings: { state: { autoUpdate: true }, update: vi.fn() },
}));

vi.mock("$lib/state/settings.svelte", () => ({ settingsStore: h.settings }));
vi.mock("$lib/state/window-tabs.svelte", () => ({ windowTabsManager: {} }));

import { generalDialogCommands } from "$lib/state/commands/general-commands";
import { updateRequest } from "$lib/state/update-request.svelte";
import { generateToggleCommands } from "$lib/state/settings-toggles";

const byId = (id: string) => generalDialogCommands.find((c) => c.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  h.settings.state.autoUpdate = true;
  h.settings.update.mockImplementation((patch: { autoUpdate?: boolean }) => {
    if (patch.autoUpdate !== undefined) h.settings.state.autoUpdate = patch.autoUpdate;
  });
});

describe("help.checkForUpdates (#1901)", () => {
  it("is a palette command labelled for search", () => {
    expect(byId("help.checkForUpdates").label).toBe("Check for Updates");
  });

  it("issues a new manual request each time it runs", async () => {
    const before = updateRequest.manualRequest;
    await byId("help.checkForUpdates").handler();
    expect(updateRequest.manualRequest).toBe(before + 1);
    await byId("help.checkForUpdates").handler();
    expect(updateRequest.manualRequest).toBe(before + 2);
  });
});

describe("auto-update palette toggle (#1901)", () => {
  it("flips the persisted setting and reports its state", async () => {
    const command = generateToggleCommands().find((c) => c.id === "setting.toggle.autoUpdate")!;
    expect(command.label).toBe("Toggle Install Updates Automatically");
    expect(command.toggleState?.()).toBe(true);

    await command.handler();
    expect(h.settings.update).toHaveBeenLastCalledWith({ autoUpdate: false });
    expect(command.toggleState?.()).toBe(false);

    await command.handler();
    expect(h.settings.update).toHaveBeenLastCalledWith({ autoUpdate: true });
    expect(command.toggleState?.()).toBe(true);
  });
});
