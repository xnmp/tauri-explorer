/**
 * Negative control: retain real-native evidence for a missing listing entry.
 *
 * Retire-when: #710 closed
 */
import { browser } from "@wdio/globals";
import { expect } from "expect-webdriverio";
import fs from "node:fs";
import path from "node:path";
import { createNativeFixtureDirectory } from "../native-qualification";
import { navigateTo } from "./helpers";
import { captureDiagnostics } from "../diagnostics/window-transfer";
import { waitForListingEntry, type ListingWaitRequest, type RendererWaitResult } from "../window-transfer-waits";

describe("native transfer diagnostic negative control", () => {
  it("retains runtime, window state and a screenshot for a deliberately missing entry", async () => {
    const scratch = createNativeFixtureDirectory("transfer-diagnostic");
    fs.writeFileSync(path.join(scratch, "diagnostic-present.txt"), "present");
    await navigateTo(scratch);
    const present = await browser.executeAsync<RendererWaitResult<true>, [ListingWaitRequest]>(
      waitForListingEntry, { name: "diagnostic-present.txt", timeoutMs: 20_000 });
    expect(present).toEqual({ ok: true, value: true });

    const missing = await browser.executeAsync<RendererWaitResult<true>, [ListingWaitRequest]>(
      waitForListingEntry, { name: "diagnostic-absent.txt", timeoutMs: 100 });
    expect(missing).toEqual({ ok: false, reason: "native listing did not contain diagnostic-absent.txt" });
    await captureDiagnostics("listing-diagnostic-absent");

    const prefix = path.resolve("e2e-tauri", "logs", "window-transfer-listing-diagnostic-absent");
    const artifact = JSON.parse(fs.readFileSync(`${prefix}.json`, "utf8"));
    expect(artifact.reason).toBe("listing-diagnostic-absent");
    expect(artifact.commit).toBe(process.env.GITHUB_SHA ?? null);
    expect(artifact.platform).toBe(process.platform);
    expect(artifact.runtime).toEqual(browser.capabilities);
    expect(artifact.windows.some((window: { panes: Array<{ entries: string[] }> }) =>
      window.panes.some((pane) => pane.entries.includes("diagnostic-present.txt")))).toBe(true);
    expect([...fs.readFileSync(`${prefix}.png`).subarray(0, 8)])
      .toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
