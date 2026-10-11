/**
 * The `config-file-changed` listener must survive a malformed payload (#1056).
 *
 * A bare-string payload once made the listener throw `undefined.startsWith`
 * on every launch. Unhandled rejections are no longer crash reports, so a
 * regression would be silent apart from a log line — this pins the listener
 * itself: drive `startConfigWatch` through a captured `listen` callback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { payload: unknown }) => void;
let listener: Listener | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_event: string, callback: Listener) => {
    listener = callback;
    return () => {};
  }),
}));

const reloadSettings = vi.fn(async () => "unchanged");
vi.mock("$lib/state/settings.svelte", () => ({
  settingsStore: { reloadFromDisk: reloadSettings },
}));
vi.mock("$lib/state/bookmarks.svelte", () => ({ bookmarksStore: { reloadFromDisk: vi.fn() } }));
vi.mock("$lib/state/folder-views.svelte", () => ({
  folderViewsStore: { reloadFromDisk: vi.fn() },
}));
vi.mock("$lib/state/theme.svelte", () => ({
  themeStore: { syncFromSettings: vi.fn(), initTheme: vi.fn() },
}));
vi.mock("$lib/state/toast.svelte", () => ({ toastStore: { show: vi.fn() } }));

async function deliver(payload: unknown): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    expect(() => listener!({ payload })).not.toThrow();
    // Let a rejected handler promise surface as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return rejections;
}

describe("config-file-changed listener", () => {
  let stop: () => void;
  beforeEach(async () => {
    reloadSettings.mockClear();
    const { startConfigWatch } = await import("$lib/state/config-watch");
    stop = startConfigWatch();
    await vi.waitFor(() => expect(listener).not.toBeNull());
  });
  afterEach(() => stop());

  it("ignores a bare-string payload without throwing or rejecting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await deliver("plugin.openai-image.json")).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(reloadSettings).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still reloads settings for an object payload", async () => {
    expect(await deliver({ filename: "settings.json" })).toEqual([]);
    expect(reloadSettings).toHaveBeenCalledTimes(1);
  });
});
