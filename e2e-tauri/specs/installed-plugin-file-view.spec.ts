/**
 * Native smoke test for an installed SDK-2 plugin package (TraceExplorer).
 *
 * Exercises what browser mocks cannot: the real `.teplugin` installed from the
 * startup queue, its frontend loaded over the `plugin:` protocol under the
 * shipped CSP (including blob workers), its backend recording provenance for a
 * core Crop Image… copy, and the contributed Trace file view and Preview info.
 *
 * Gated: set TRACE_EXPLORER_PLUGIN_SMOKE=1 and queue the package into the
 * (isolated) profile's `pending-plugins` directory before launching, e.g. with
 * TraceExplorer's `scripts/host-smoke.sh`.
 */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { domText, entryPathSelector, navigateTo } from "./helpers";
import { gatedDescribe } from "./gated-describe";
import { createNativeFixtureDirectory } from "../native-qualification";

const enabled = process.env.TRACE_EXPLORER_PLUGIN_SMOKE === "1";
const count = (selector: string) => browser.execute((query: string) => document.querySelectorAll(query).length, selector);
const fixture = fileURLToPath(new URL("../fixtures/image-crop/quadrants.png", import.meta.url));

async function command(label: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed(); await input.setValue(label);
  await browser.waitUntil(async () => (await domText(".command-palette-dialog")).includes(label));
  await browser.keys("Enter");
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}

gatedDescribe("installed plugin file view (TraceExplorer package)", [[enabled, "TRACE_EXPLORER_PLUGIN_SMOKE=1 with a queued package"]], () => {
  const scratch = enabled ? fs.realpathSync(createNativeFixtureDirectory("trace-plugin-smoke-")) : "";
  const source = path.join(scratch, "source.png");

  before(() => { fs.copyFileSync(fixture, source); });

  it("installs the queued package and activates it", async () => {
    const installed = await browser.executeAsync((done: (value: unknown) => void) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__;
      internals.invoke("list_installed_plugins").then(done, (error) => done({ error: String(error) }));
    }) as Array<{ manifest: { id: string; sdkVersion: number }; enabled: boolean }>;
    const trace = installed.find((entry) => entry.manifest.id === "xnmp.trace-explorer");
    expect(trace?.enabled).toBe(true);
    expect(trace?.manifest.sdkVersion).toBe(2);
  });

  it("permits plugin blob workers under the shipped CSP", async () => {
    const reply = await browser.executeAsync((done: (value: string) => void) => {
      try {
        const url = URL.createObjectURL(new Blob(["onmessage = (event) => postMessage(event.data + ':ok')"], { type: "text/javascript" }));
        const worker = new Worker(url);
        worker.onmessage = (event) => { worker.terminate(); done(String(event.data)); };
        worker.onerror = () => done("error");
        worker.postMessage("ping");
      } catch (error) { done(`threw ${String(error)}`); }
    });
    expect(reply).toBe("ping:ok");
  });

  it("records a crop and shows it in the Trace view with Preview info", async () => {
    await navigateTo(scratch);
    await $(entryPathSelector(source)).click();
    if (!await $(".preview-pane").isDisplayed()) {
      await browser.keys(" ");
      await $(".preview-pane").waitForDisplayed();
    }
    await command("Crop Image…");
    await $('[role="slider"][aria-label="Right crop edge"]').waitForDisplayed();
    await $("button=Save copy").click();
    await $('[role="dialog"][aria-label="Edit image"]').waitForDisplayed({ reverse: true });
    await browser.waitUntil(async () => fs.readdirSync(scratch).filter((name) => name.endsWith(".png")).length === 2,
      { timeoutMsg: "the crop copy was not published" });

    await command("Toggle Trace View");
    await $('[data-file-view="trace.view"]').waitForDisplayed({ timeout: 15_000 });
    await browser.waitUntil(async () => await count("[data-tile-key]") >= 2, { timeoutMsg: "Trace did not show the source and its crop" });
    expect(await count("path[data-route]")).toBeGreaterThanOrEqual(1);

    // The crop is the child: the tile that has an incoming route ends lowest.
    await browser.execute(() => {
      const cards = [...document.querySelectorAll<HTMLElement>("[data-tile-key] button.card")];
      cards.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0].click();
    });
    await browser.waitUntil(async () => (await domText(".preview-pane")).includes("Trace"), { timeoutMsg: "Preview info has no Trace section" });
    expect(await domText(".preview-pane")).toContain("Inputs");

    await command("Toggle Trace View");
    await $('[data-file-view="trace.view"]').waitForDisplayed({ reverse: true });
    await $(entryPathSelector(source)).waitForDisplayed();
  });
});
