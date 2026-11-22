import { afterEach, expect, it, vi } from "vitest";
import type { Drive } from "$lib/api/drives";

// #1894: on a Windows host the store must hand the Google Drive for desktop
// letter to the sidebar's Cloud & Remote section (the only place it renders).
const mocks = vi.hoisted(() => ({ list: vi.fn(), live: vi.fn(), listen: vi.fn() }));
vi.mock("$lib/domain/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$lib/domain/platform")>()),
  isWindows: true,
}));
vi.mock("$lib/api/drives", () => ({
  listDrives: mocks.list, driveUpdatesLive: mocks.live, DRIVES_CHANGED_EVENT: "drives-changed",
}));
vi.mock("$lib/api/files", () => ({ watchDirectory: vi.fn(), unwatchDirectory: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
import { drivesStore } from "$lib/state/drives.svelte";

afterEach(async () => {
  await drivesStore.stopPolling();
  vi.resetAllMocks();
});

it("lists Google Drive for desktop in the Windows sidebar cloud section", async () => {
  const google: Drive = {
    name: "Google Drive", path: "G:\\", kind: "cloud", detail: "G:", provider: "googledrive",
  };
  const system: Drive = { name: "C:", path: "C:\\", kind: "fixed" };
  mocks.list.mockResolvedValue({ ok: true, data: [system, google] });
  mocks.live.mockResolvedValue(false);
  mocks.listen.mockResolvedValue(() => {});
  await drivesStore.startPolling();
  expect(drivesStore.cloud).toEqual([google]);
});
