import { describe, expect, it } from "vitest";
import { isRendererRecovery, launchRequest, planWindowLaunch } from "$lib/domain/window-launch-plan";

describe("window launch navigation policy", () => {
  it("uses child navigation and view without restoring or overriding from the parent cwd", () => {
    expect(planWindowLaunch("?path=%2Fchild&viewMode=tiles", { cwd: "/parent" }, "/home/me")).toEqual({
      homePath: "/home/me", initialPath: "/child", skipRestore: true, overridePath: undefined, viewMode: "tiles",
    });
  });

  it("restores a main window directly at a meaningful terminal cwd", () => {
    expect(planWindowLaunch("", { cwd: "/work/repo" }, "/home/me")).toMatchObject({
      initialPath: "/work/repo", skipRestore: false, overridePath: "/work/repo",
    });
  });

  it.each([undefined, "/", "/home/me"])("keeps saved navigation for generic cwd %s", (cwd) => {
    expect(planWindowLaunch("", { cwd }, "/home/me")).toMatchObject({ skipRestore: false, overridePath: undefined });
  });

  it.each([null, [], { cwd: 1 }, { cwd: "bad\0path" }, { cwd: "x".repeat(32_769) }])(
    "falls back to home for malformed launch data %#", (raw) => {
      expect(planWindowLaunch("?path=&viewMode=wrong", raw, "/home/me")).toEqual({
        homePath: "/home/me", initialPath: "/home/me", skipRestore: false, overridePath: undefined, viewMode: undefined,
      });
    },
  );

  describe("after the native layer reloads a lost renderer (#942)", () => {
    it("restores a child window's own session instead of reopening its launch path", () => {
      expect(planWindowLaunch("?path=%2Fchild&viewMode=tiles&focusAddressBar=1&rendererRecovery=1",
        null, "/home/me")).toEqual({
        homePath: "/home/me", initialPath: "/child", skipRestore: false, overridePath: undefined, viewMode: undefined,
      });
    });

    it("does not move a restored main window back to its terminal cwd", () => {
      expect(planWindowLaunch("?rendererRecovery=1", { cwd: "/work/repo" }, "/home/me")).toEqual({
        homePath: "/home/me", initialPath: "/work/repo", skipRestore: false, overridePath: undefined, viewMode: undefined,
      });
    });

    it("withholds one-shot launch requests from the replacement document", () => {
      const search = "?warm=1&focusAddressBar=1&path=%2Fx&rendererRecovery=1";
      expect(isRendererRecovery(search)).toBe(true);
      expect(launchRequest(search, "warm")).toBeNull();
      expect(launchRequest(search, "focusAddressBar")).toBeNull();
      expect(launchRequest("?warm=1&focusAddressBar=1", "warm")).toBe("1");
      expect(launchRequest("?focusAddressBar=1", "focusAddressBar")).toBe("1");
    });

    it.each(["?rendererRecovery=0", "?rendererRecovery=", "?rendererrecovery=1", ""])(
      "treats %j as an ordinary launch", (search) => {
        expect(isRendererRecovery(search)).toBe(false);
        expect(planWindowLaunch(`${search}${search ? "&" : "?"}path=%2Fchild`, null, "/home/me"))
          .toMatchObject({ skipRestore: true });
      },
    );
  });

  it("ignores invalid query paths and preserves cross-platform native paths", () => {
    expect(planWindowLaunch("?path=bad%00path", { cwd: "C:\\work" }, "C:\\Users\\me")).toMatchObject({
      initialPath: "C:\\work", skipRestore: false, overridePath: "C:\\work",
    });
    const unc = "\\\\server\\share";
    expect(planWindowLaunch(`?path=${encodeURIComponent(unc)}`, null)).toMatchObject({ initialPath: unc, skipRestore: true });
    expect(planWindowLaunch(`?path=${"x".repeat(32_769)}`, null)).toMatchObject({ initialPath: "/home", skipRestore: false });
  });
});
