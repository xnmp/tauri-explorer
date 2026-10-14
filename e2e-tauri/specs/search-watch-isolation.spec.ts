/** Opt-in real binary acceptance, run on a private display with a fresh profile. */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createNativeFixtureDirectory } from "../native-qualification";
import { navigateTo, entryPathSelector } from "./helpers";

const gate = process.env.TAURI_EXPLORER_E2E_SEARCH_WATCH_GATE;
(gate ? describe : describe.skip)("recursive search watch navigation isolation", () => {
  it("lists another folder before the blocked recursive registration is released", async () => {
    const fixture = createNativeFixtureDirectory("search-watch-isolation-");
    const searchRoot = path.join(fixture, "search-root");
    const destination = path.join(fixture, "navigation-still-works");
    fs.mkdirSync(searchRoot);
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(searchRoot, "needle.txt"), "search");
    // A real large-tree registration workload; cancellation can revoke its
    // demand while the native gate holds admission.
    for (let i = 0; i < 4096; i++) {
      const leaf = path.join(searchRoot, `branch-${i}`, "nested");
      fs.mkdirSync(leaf, { recursive: true });
      fs.writeFileSync(path.join(leaf, "needle.txt"), "search");
    }
    const output = "screenshots/fix/quick-open-watch-navigation-stall";
    fs.mkdirSync(output, { recursive: true });
    const marker = path.join(destination, "Navigation completed while search watch was blocked.txt");
    fs.writeFileSync(marker, "independent folder listing");
    const entered = gate!.replace(/\.[^/.]*$/, "") + ".entered";
    const exited = gate!.replace(/\.[^/.]*$/, "") + ".exited";
    try {
      await navigateTo(searchRoot);
      await browser.keys(["Control", "p"]);
      const input = $(".quick-open-dialog .search-input");
      await input.waitForDisplayed();
      await input.setValue("needle");
      await browser.waitUntil(() => fs.existsSync(entered), { timeout: 10_000, timeoutMsg: "recursive registration did not enter its native gate" });
      expect(fs.readFileSync(entered, "utf8")).toBe(searchRoot);
      expect(fs.existsSync(exited)).toBe(false);
      await browser.keys("Escape");
      await $(".quick-open-dialog").waitForDisplayed({ reverse: true });
      const started = Date.now();
      await navigateTo(destination);
      await expect($(entryPathSelector(marker))).toBeDisplayed();
      const elapsedMs = Date.now() - started;
      expect(fs.existsSync(gate!)).toBe(false);
      expect(elapsedMs).toBeLessThan(5_000);

      await browser.saveScreenshot(path.join(output, "navigation-during-recursive-registration.png"));
      expect(fs.existsSync(exited)).toBe(false);
      fs.writeFileSync(path.join(output, "native-result.json"), JSON.stringify({
        syntheticDirectories: 8192, destinationEntries: 1, elapsedMs,
        registrationReleased: false, nativeGateStillBlocked: true,
      }, null, 2) + "\n");
    } catch (error) {
      await browser.saveScreenshot(path.join(output, "navigation-failure.png"));
      throw error;
    } finally {
      // Release before navigating away/cleanup so the worker can finish and
      // the cancelled search cannot outlive its fixture.
      fs.writeFileSync(gate!, "release");
      await navigateTo(os.tmpdir());
      // Run-owned fixture cleanup waits for native app teardown.
    }
  });
});
