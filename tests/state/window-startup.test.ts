import { describe, expect, it, vi } from "vitest";
import { startWindowStartup } from "$lib/state/window-startup";

function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(settings = pending()) {
  const calls: string[] = [];
  const dependencies = {
    loadSettings: () => settings.promise,
    synchronizeTheme: () => { calls.push("theme"); },
    publishSettingsReady: () => { calls.push("ready"); },
    initializePlugins: vi.fn(async () => { calls.push("plugins"); }),
    disposePlugins: vi.fn(async () => { calls.push("dispose"); }),
  };
  return { settings, calls, dependencies };
}

describe("window startup ownership", () => {
  it("publishes configured core readiness before optional plugin activation finishes", async () => {
    const { settings, calls, dependencies } = setup();
    const activation = pending();
    dependencies.initializePlugins.mockImplementation(() => {
      calls.push("plugins");
      return activation.promise;
    });
    const startup = startWindowStartup(dependencies);
    expect(calls).toEqual([]);
    settings.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["theme", "ready", "plugins"]);
    const disposal = startup.dispose();
    expect(startup.dispose()).toBe(disposal);
    expect(dependencies.disposePlugins).toHaveBeenCalledOnce();
    activation.resolve();
    await Promise.all([startup.ready, disposal]);
  });

  it("never starts plugins or publishes readiness from settings completing after teardown", async () => {
    const { settings, calls, dependencies } = setup();
    const startup = startWindowStartup(dependencies);
    await startup.dispose();
    settings.resolve();
    await startup.ready;
    expect(calls).toEqual(["dispose"]);
  });

  it("propagates settings failure without publishing partial readiness", async () => {
    const { calls, dependencies } = setup();
    const failure = new Error("settings unavailable");
    dependencies.loadSettings = () => Promise.reject(failure);
    const startup = startWindowStartup(dependencies);
    await expect(startup.ready).rejects.toBe(failure);
    expect(calls).toEqual([]);
    await startup.dispose();
  });
});
