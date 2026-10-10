/**
 * The runtime SDK that precompiled plugin packages bind to: its announced
 * capabilities and host component modules are a contract with those packages.
 */
import { expect, it } from "vitest";
import { exposePluginSDK } from "$lib/plugins/runtime-sdk";

interface Sdk {
  sdkVersion: number;
  apiVersion: number;
  capabilities: readonly string[];
  modules: Record<string, { default?: unknown }>;
}

it("announces the file-tiles module and pane tile sizes alongside the existing SDK 2 contract", () => {
  exposePluginSDK();
  const sdk = (globalThis as { __TAURI_EXPLORER_PLUGIN_SDK__?: Sdk }).__TAURI_EXPLORER_PLUGIN_SDK__!;
  expect(sdk.sdkVersion).toBe(1);
  expect(sdk.apiVersion).toBe(3);
  expect(sdk.capabilities).toEqual(expect.arrayContaining(["fileViews", "previewInfo", "previewTargets", "blobWorkers", "fileTiles", "tileSize", "jobRetry", "textGeneration", "pluginServices", "serviceArtifacts", "settingsActions", "modalNavigation"]));
  for (const name of ["ui/modal", "ui/image-editor", "ui/file-tiles"]) {
    expect(typeof sdk.modules[name]?.default, name).toBe("function");
  }
  expect(Object.isFrozen(sdk.capabilities)).toBe(true);
  // Exposing twice keeps the first, frozen binding.
  exposePluginSDK();
  expect((globalThis as { __TAURI_EXPLORER_PLUGIN_SDK__?: Sdk }).__TAURI_EXPLORER_PLUGIN_SDK__).toBe(sdk);
});
