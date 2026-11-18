import { describe, expect, it } from "vitest";
import { planDemoBoot, resolveDemoAssetBase, withoutDemoWorld } from "$lib/domain/demo-boot";
import { CURRENT_SETTINGS_VERSION } from "$lib/domain/settings-migration";

const ctx = { now: Date.UTC(2026, 9, 18), pageUrl: "http://site.test/overhaul/real.html" };
const fixture = {
  users: [{ id: "ines", home: "/home/ines", bookmarks: ["/home/ines/Field"] }],
  tree: { kids: [{ name: "home", kids: [{ name: "ines", kids: [{ name: "Field", kids: [{ name: "a.txt", text: "a" }] }] }] }] },
};
const settingsOf = (plan: ReturnType<typeof planDemoBoot>) => JSON.parse(plan.storage["explorer-settings"]);

describe("planDemoBoot", () => {
  it("seeds the fixture world, host settings, keybindings, bookmarks and launch path", () => {
    const plan = planDemoBoot({
      fixture, settings: { theme: "nord" }, keybindings: { "view.toggleSidebar": "Ctrl+B" }, startPath: "/home/ines/Field",
    }, ctx);
    expect(plan.report).toEqual({ fixture: "provided", error: null, warnings: [] });
    expect(plan.world?.user.home).toBe("/home/ines");
    expect(settingsOf(plan)).toMatchObject({ theme: "nord", enableTerminal: true, settingsVersion: CURRENT_SETTINGS_VERSION });
    expect(JSON.parse(plan.storage["explorer-keybindings"])).toEqual({ "view.toggleSidebar": "Ctrl+B" });
    expect(JSON.parse(plan.storage["explorer-bookmarks"])).toEqual([{ name: "Field", path: "/home/ines/Field", icon: "folder" }]);
    expect(JSON.parse(plan.storage["mock-config-files"])).toHaveProperty("settings.json");
    // The desktop's default system folders would be dead links into the fixture.
    expect(JSON.parse(plan.storage["explorer-hidden-system-folders"])).toEqual(expect.arrayContaining(["Downloads", "Documents", "Pictures", "Videos", "Music"]));
    expect(plan.launch).toEqual({ home: "/home/ines", cwd: "/home/ines/Field" });
  });

  it("boots the built-in fixtures without a host", () => {
    const plan = planDemoBoot(null, ctx);
    expect(plan.world).toBeNull();
    expect(plan.launch).toBeNull();
    expect(plan.report).toEqual({ fixture: "builtin", error: null, warnings: [] });
    expect(settingsOf(plan)).toMatchObject({ enableTerminal: true, enableGitGraph: true });
  });

  it("drops settings that cannot be stored (cyclic, BigInt) and says so", () => {
    const cyclic: Record<string, unknown> = { theme: "nord" };
    cyclic.self = cyclic;
    for (const settings of [cyclic, { zoom: BigInt(2) }]) {
      const plan = planDemoBoot({ fixture, settings }, ctx);
      expect(plan.report.fixture).toBe("provided");
      expect(plan.report.warnings.join(" ")).toMatch(/settings/);
      expect(settingsOf(plan)).not.toHaveProperty("theme");
    }
  });

  it("keeps only string or null shortcuts from keybindings", () => {
    const plan = planDemoBoot({ fixture, keybindings: { a: "Ctrl+A", b: null, c: 3, d: { x: 1 } } as never }, ctx);
    expect(JSON.parse(plan.storage["explorer-keybindings"])).toEqual({ a: "Ctrl+A", b: null });
    expect(planDemoBoot({ fixture, keybindings: [1, 2] as never }, ctx).report.warnings.join(" ")).toMatch(/keybindings/);
  });

  it("ignores an unusable asset base and a start path outside the world", () => {
    const plan = planDemoBoot({ fixture, assetBase: "http://[", startPath: "/nowhere" }, ctx);
    expect(plan.report.fixture).toBe("provided");
    expect(plan.report.warnings.join(" ")).toMatch(/assetBase/);
    expect(plan.report.warnings.join(" ")).toMatch(/nowhere/);
    expect(plan.launch).toEqual({ home: "/home/ines", cwd: "/home/ines" });
  });

  it("fails closed to the built-in fixtures when reading the fixture throws, reporting why", () => {
    const hostile = { get tree() { throw new Error("tree getter exploded"); }, users: [] };
    const plan = planDemoBoot({ fixture: hostile, settings: { theme: "nord" } }, ctx);
    expect(plan.world).toBeNull();
    expect(plan.launch).toBeNull();
    expect(plan.report.fixture).toBe("builtin");
    expect(plan.report.error).toMatch(/tree getter exploded/);
    expect(settingsOf(plan)).not.toHaveProperty("theme");
  });

  it.each([1e20, "99999999 years ago", 9e15])("survives an unrepresentable date %j anywhere in the fixture", (date) => {
    const plan = planDemoBoot({
      fixture: { ...fixture, tree: { kids: [{ name: "x.txt", text: "x", date }] }, trash: [{ from: "/", node: { name: "y" }, deleted: date }] },
    }, ctx);
    expect(plan.report.error).toBeNull();
    expect(plan.world).not.toBeNull();
  });
});

describe("resolveDemoAssetBase", () => {
  it.each([
    [undefined, "http://site.test/overhaul/real.html"],
    ["../assets/", "http://site.test/assets/"],
    ["https://cdn.test/a/", "https://cdn.test/a/"],
  ])("%j → %s", (raw, expected) => {
    expect(resolveDemoAssetBase(raw, ctx.pageUrl)).toEqual({ url: expected, warning: null });
  });

  it.each(["http://[", "javascript:alert(1)", "data:text/html,x"])("rejects %j", (raw) => {
    expect(resolveDemoAssetBase(raw, ctx.pageUrl)).toMatchObject({ url: ctx.pageUrl, warning: expect.stringMatching(/assetBase/) });
  });
});

describe("withoutDemoWorld", () => {
  it("keeps the host's settings and keybindings but drops the world, its bookmarks and launch path", () => {
    const plan = withoutDemoWorld(planDemoBoot({ fixture, settings: { theme: "nord" }, keybindings: { a: "Ctrl+A" } }, ctx), "install failed");
    expect(plan).toMatchObject({ world: null, launch: null, report: { fixture: "builtin", error: "install failed" } });
    expect(settingsOf(plan)).toMatchObject({ theme: "nord" });
    expect(JSON.parse(plan.storage["explorer-keybindings"])).toEqual({ a: "Ctrl+A" });
    expect(plan.storage).not.toHaveProperty("explorer-bookmarks");
    expect(JSON.parse(plan.storage["mock-config-files"])).not.toHaveProperty("bookmarks.json");
  });
});
