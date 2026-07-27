import { beforeEach, describe, expect, it, vi } from "vitest";

const windowApi = vi.hoisted(() => ({
  setTitle: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));

import { syncWindowTitle } from "../../src/lib/state/window-title";

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
