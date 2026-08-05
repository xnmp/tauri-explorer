// Failure-safe lazy dialog loading (#584): a rejected chunk import must roll
// back the dialog's open-state and notify the user, otherwise the stuck flag
// feeds dialogStore.hasModalOpen and soft-locks every global shortcut.
import { describe, expect, it, vi } from "vitest";
import { loadDialogComponent } from "$lib/domain/lazy-dialog";

describe("loadDialogComponent", () => {
  it("assigns the module default on success and does not notify", async () => {
    const component = { marker: "theme-picker" };
    const onLoaded = vi.fn();
    const onFailure = vi.fn();
    const notify = vi.fn();

    await loadDialogComponent({ label: "Theme Picker", load: () => Promise.resolve({ default: component }), onLoaded, onFailure }, notify);

    expect(onLoaded).toHaveBeenCalledWith(component);
    expect(onFailure).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("rolls back open-state and notifies when the import rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onLoaded = vi.fn();
    const onFailure = vi.fn();
    const notify = vi.fn();

    await loadDialogComponent({ label: "Theme Picker", load: () => Promise.reject(new Error("chunk load failed")), onLoaded, onFailure }, notify);

    expect(onLoaded).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0][0]).toContain("Theme Picker");
  });

  it("still notifies when no rollback is registered (portal picker windows)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = vi.fn();

    await loadDialogComponent({ label: "File Picker", load: () => Promise.reject(new Error("offline")), onLoaded: vi.fn() }, notify);

    expect(notify).toHaveBeenCalledOnce();
  });

  it("never rejects, even when rollback and notification both throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn(() => {
      throw new Error("rollback exploded");
    });
    const notify = vi.fn(() => {
      throw new Error("toast exploded");
    });

    await expect(loadDialogComponent({ label: "Settings", load: () => Promise.reject(new Error("bad chunk")), onLoaded: vi.fn(), onFailure }, notify)).resolves.toBeUndefined();

    expect(onFailure).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("notifies even when only the rollback throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const notify = vi.fn();

    await loadDialogComponent(
      {
        label: "Jobs Panel",
        load: () => Promise.reject(new Error("bad chunk")),
        onLoaded: vi.fn(),
        onFailure: () => {
          throw new Error("rollback exploded");
        },
      },
      notify,
    );

    expect(notify).toHaveBeenCalledOnce();
  });

  it("treats a throwing onLoaded as a failure: rollback + notify, never a soft-lock", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn();
    const notify = vi.fn();

    await loadDialogComponent(
      {
        label: "Settings",
        load: () => Promise.resolve({ default: {} }),
        onLoaded: () => {
          throw new Error("assignment exploded");
        },
        onFailure,
      },
      notify,
    );

    expect(onFailure).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
  });
});
