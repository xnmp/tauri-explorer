import { beforeEach, describe, expect, it, vi } from "vitest";

const windowApi = vi.hoisted(() => ({
  setTitle: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));

import {
  resolveLaunchHomePath,
  syncWindowTitle,
} from "../../src/lib/state/window-title.svelte";

describe("resolveLaunchHomePath", () => {
  it("prefers Rust-injected launch data in the main window", () => {
    expect(
      resolveLaunchHomePath({
        __LAUNCH_DATA__: { home: "/home/main" },
        location: { search: "?home=%2Fhome%2Fchild" },
      }),
    ).toBe("/home/main");
  });

  it("uses the inherited query parameter in child and warm windows", () => {
    expect(resolveLaunchHomePath({ location: { search: "?home=%2FUsers%2FAlice" } })).toBe(
      "/Users/Alice",
    );
  });

  it("returns undefined when no launch home is available", () => {
    expect(resolveLaunchHomePath({ location: { search: "" } })).toBeUndefined();
    expect(resolveLaunchHomePath(undefined)).toBeUndefined();
  });
});

describe("syncWindowTitle", () => {
  beforeEach(() => windowApi.setTitle.mockClear());

  it.each([
    ["/work/alpha", "/home/user", "alpha - Tauri Explorer"],
    ["/home/user", "/home/user", "~ - Tauri Explorer"],
    ["", "/home/user", "Tauri Explorer"],
  ])("sets the current Tauri window title for %j", async (path, home, expected) => {
    await syncWindowTitle(path, home);
    expect(windowApi.setTitle).toHaveBeenLastCalledWith(expected);
  });
});
