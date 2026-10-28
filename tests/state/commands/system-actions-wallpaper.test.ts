/**
 * Set as Wallpaper reports what it could and could not change (#1441):
 * a partial backend outcome becomes an info toast, a full success stays
 * silent, and a failure stays an error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const show = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/api/common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/api/common")>()),
  invoke,
}));
vi.mock("../../../src/lib/state/toast.svelte", () => ({ toastStore: { show } }));
vi.mock("../../../src/lib/state/settings.svelte", () => ({ settingsStore: { terminalApp: "" } }));

import { setWallpaper } from "../../../src/lib/state/commands/system-actions";

describe("setWallpaper", () => {
  beforeEach(() => {
    invoke.mockReset();
    show.mockReset();
  });

  it("shows the backend's notice when only part of the change was applied", async () => {
    const notice = "Only the current Space was changed: macOS 13 offers no supported way.";
    invoke.mockResolvedValue({ notice });
    await setWallpaper("/pics/a b.png");
    expect(invoke).toHaveBeenCalledWith("set_as_wallpaper", { path: "/pics/a b.png" });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toBe(notice);
    expect(show.mock.calls[0][1]).toBe("info");
  });

  it("stays silent on complete success, including older backends that return nothing", async () => {
    for (const outcome of [{ notice: null }, {}, undefined]) {
      invoke.mockResolvedValue(outcome);
      await setWallpaper("/pics/a.png");
    }
    expect(show).not.toHaveBeenCalled();
  });

  it("reports a failure as an error", async () => {
    invoke.mockRejectedValue("Failed to set wallpaper: not permitted");
    await setWallpaper("/pics/a.png");
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toContain("not permitted");
    expect(show.mock.calls[0][1]).toBe("error");
  });
});
