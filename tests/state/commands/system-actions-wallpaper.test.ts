/**
 * Set as Wallpaper reports what it could and could not change (#1441,
 * #1731): a partial backend outcome becomes exactly one info toast carrying
 * the backend's short notice, a full success stays silent, and a failure
 * stays an error.
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

  it.each([
    "Could only change wallpaper on some displays",
    "Could only change wallpaper on the current Space",
  ])("shows a partial result as one info toast: %s", async (notice) => {
    invoke.mockResolvedValue({ notice });
    await setWallpaper("/pics/a b.png");
    expect(invoke).toHaveBeenCalledWith("set_as_wallpaper", { path: "/pics/a b.png" });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toBe(notice);
    expect(show.mock.calls[0][1]).toBe("info");
  });

  it("does not add a success toast alongside a partial notice", async () => {
    invoke.mockResolvedValue({ notice: "Could only change wallpaper on the current Space" });
    await setWallpaper("/pics/a.png");
    expect(show.mock.calls.map(([, kind]) => kind)).toEqual(["info"]);
  });

  it("treats an empty notice as complete success", async () => {
    invoke.mockResolvedValue({ notice: "" });
    await setWallpaper("/pics/a.png");
    expect(show).not.toHaveBeenCalled();
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
