import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), error: vi.fn() }));
vi.mock("$lib/api/common", () => ({ invoke: h.invoke, isTauri: () => true, extractError: String }));
vi.mock("@tauri-apps/api/event", () => ({ listen: h.listen }));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: { error: h.error } }));
beforeEach(() => {
  vi.resetModules(); h.invoke.mockReset(); h.listen.mockReset(); h.error.mockReset();
  h.listen.mockResolvedValue(() => {});
});
const registry = { registerInstalled: vi.fn(), removeInstalled: vi.fn() };

it("reports queued installation failures once while retaining registry change notifications", async () => {
  h.invoke.mockResolvedValue(["Queued plugin could not be installed: invalid archive", "Second package failed"]);
  const { watchInstalledPackages } = await import("$lib/plugins/installed");
  await watchInstalledPackages(registry); await watchInstalledPackages(registry);
  expect(h.error).toHaveBeenCalledExactlyOnceWith("Queued plugin could not be installed: invalid archive; Second package failed");
  expect(h.invoke).toHaveBeenCalledExactlyOnceWith("take_pending_plugin_install_errors");
  expect(h.listen).toHaveBeenCalledTimes(1);
});

it("does not duplicate registry listeners if reading startup failures fails", async () => {
  h.invoke.mockRejectedValue(new Error("Reply lost"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { watchInstalledPackages } = await import("$lib/plugins/installed");
    await watchInstalledPackages(registry); await watchInstalledPackages(registry);
    expect(h.listen).toHaveBeenCalledTimes(1);
    expect(h.error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

it("surfaces a profile-ownership refusal that names the holding process verbatim (#1433)", async () => {
  const refusal = "Another Tauri Explorer process owns this plugin profile (held by /usr/bin/tauri-explorer (PID 4242, owner since 2026-10-29 09:15:00)); AI operations and plugin changes are available there until it exits";
  h.invoke.mockResolvedValue([refusal]);
  const { watchInstalledPackages } = await import("$lib/plugins/installed");
  await watchInstalledPackages(registry);
  expect(h.error).toHaveBeenCalledExactlyOnceWith(refusal);
  expect(h.error.mock.calls[0][0]).toMatch(/held by \/usr\/bin\/tauri-explorer \(PID 4242, owner since /);
});
