import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("$lib/api/common", () => ({ invoke, extractError: String, isTauri: () => false }));
import { installPackage, type InstalledPackage } from "$lib/plugins/installed";

const registry = { registerInstalled: vi.fn(), removeInstalled: vi.fn() };
const entry: InstalledPackage = {
  digest: "fixture", enabled: false,
  manifest: { id: "fixture", name: "Fixture", description: "", version: "1", sdkVersion: 1, svelteVersion: "5.56.3", frontend: "index.js", styles: "style.css", contributions: [] },
};
describe("package installation", () => {
  beforeEach(() => { invoke.mockReset(); });

  it("requests a package-only picker then installs the selected archive and refreshes", async () => {
    invoke.mockImplementation(async (command: string) => command === "pick_file" ? "/downloads/TraceExplorer.teplugin" : command === "list_installed_plugins" ? [] : entry);
    await installPackage(registry);
    expect(invoke).toHaveBeenCalledWith("pick_file", { options: { mode: "open", title: "Install plugin package", extensions: ["teplugin"] } });
    expect(invoke).toHaveBeenCalledWith("install_plugin", { path: "/downloads/TraceExplorer.teplugin" });
    expect(invoke).toHaveBeenCalledWith("list_installed_plugins");
  });

  it("cancels without installing or refreshing", async () => {
    invoke.mockResolvedValue(null);
    await installPackage(registry);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["pick_file"]);
  });

  it("surfaces an installation failure without pretending to refresh", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "pick_file") return "/downloads/bad.teplugin";
      throw new Error("Invalid plugin package");
    });
    await expect(installPackage(registry)).rejects.toThrow("Invalid plugin package");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["pick_file", "install_plugin"]);
  });

  it("reports a package that installed successfully but cannot activate", async () => {
    const incompatible = { ...entry, enabled: true, manifest: { ...entry.manifest, sdkVersion: 4 } };
    invoke.mockImplementation(async (command: string) => command === "pick_file" ? "/downloads/Fixture.teplugin" : command === "list_installed_plugins" ? [incompatible] : incompatible);
    await expect(installPackage(registry)).rejects.toThrow("Fixture was installed but could not start");
    expect(invoke).toHaveBeenCalledWith("install_plugin", { path: "/downloads/Fixture.teplugin" });
  });
});
