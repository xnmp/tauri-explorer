/**
 * Plugin settings seed race (#154): a user edit made before the persisted
 * storage blob resolves must not be clobbered by the async load.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { pluginSettingsSections } from "$lib/plugins/settings-registry.svelte";
import type { PluginStorage, SettingsSectionDescriptor } from "$lib/plugins/api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush pending microtasks (the get().then().finally() chain). */
const flush = () => new Promise((r) => setTimeout(r, 0));

const desc: SettingsSectionDescriptor = {
  id: "sec",
  title: "Section",
  rows: [
    { id: "apiKey", label: "API Key", type: "text", default: "" },
    { id: "model", label: "Model", type: "text", default: "auto" },
  ],
};

describe("plugin settings seed race", () => {
  beforeEach(() => pluginSettingsSections.clear());

  it("keeps a user edit made before the persisted load resolves", async () => {
    const load = deferred<Record<string, unknown>>();
    const storage: PluginStorage = {
      get: () => load.promise,
      set: async () => {},
    };

    pluginSettingsSections.register("demo", desc, storage);
    const section = pluginSettingsSections.sections.find((s) => s.id === "sec")!;

    // User edits apiKey while the load is still in flight.
    section.setValue("apiKey", "user-typed");

    // Persisted blob resolves later with a stale value for the same key plus a
    // value for an untouched key.
    load.resolve({ apiKey: "stale-from-disk", model: "gpt" });
    await flush();

    // The in-flight edit wins; the untouched key adopts the loaded value.
    expect(section.valueOf(desc.rows[0])).toBe("user-typed");
    expect(section.valueOf(desc.rows[1])).toBe("gpt");
  });

  it("applies the loaded blob normally when there is no concurrent edit", async () => {
    const load = deferred<Record<string, unknown>>();
    const storage: PluginStorage = { get: () => load.promise, set: async () => {} };

    pluginSettingsSections.register("demo2", desc, storage);
    const section = pluginSettingsSections.sections.find((s) => s.id === "sec")!;

    load.resolve({ apiKey: "from-disk", model: "gpt" });
    await flush();

    expect(section.valueOf(desc.rows[0])).toBe("from-disk");
    expect(section.valueOf(desc.rows[1])).toBe("gpt");
  });

  it("falls back to defaults + edits when the load rejects", async () => {
    const load = deferred<Record<string, unknown>>();
    const storage: PluginStorage = { get: () => load.promise, set: async () => {} };

    pluginSettingsSections.register("demo3", desc, storage);
    const section = pluginSettingsSections.sections.find((s) => s.id === "sec")!;

    section.setValue("apiKey", "typed-before-fail");
    load.reject(new Error("read failed"));
    await flush();

    expect(section.valueOf(desc.rows[0])).toBe("typed-before-fail");
    expect(section.valueOf(desc.rows[1])).toBe("auto"); // default retained
  });
});
