/** #678: actual native moves update visible lazy folder cues without navigation. */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { createNativeFixtureDirectory } from "../native-qualification";
import { navigateTo, entryPathSelector, domText } from "./helpers";

const modes = ["details", "list", "tiles"] as const;
const proof = path.resolve("screenshots/fix/678-empty-folder-ghost-indicator-remains-eve");

async function command(label: string): Promise<void> {
  await browser.keys(["Control", "Shift", "p"]);
  const input = $(".command-palette-dialog .search-input");
  await input.waitForDisplayed();
  await input.setValue(label);
  const item = $(`//li[contains(@class,'command-item')][span[contains(@class,'command-label') and text()='${label}']]`);
  await item.waitForDisplayed();
  await item.click();
  await $(".command-palette-dialog").waitForDisplayed({ reverse: true });
}

async function selectView(mode: typeof modes[number]): Promise<void> {
  await command(`${mode[0].toUpperCase()}${mode.slice(1)} View`);
  await $(`.${mode}-view`).waitForExist();
}

async function setHidden(visible: boolean): Promise<void> {
  await browser.keys(["Control", ","]);
  const settings = $(".settings-dialog");
  await settings.waitForDisplayed();
  await settings.$(".settings-search").setValue("Show Hidden Files");
  const row = $("//div[contains(@class,'setting-row')][.//span[text()='Show Hidden Files']]");
  if (await row.$('input[type="checkbox"]').isSelected() !== visible) {
    await row.$(".toggle-slider").click();
  }
  await settings.$(".close-btn").click();
  await settings.waitForDisplayed({ reverse: true });
}

async function move(sources: string[], destination: string): Promise<{ error: string | null; complete: boolean }> {
  const token = crypto.randomUUID();
  await browser.waitUntil(async () => await browser.execute(() =>
    document.documentElement.dataset.e2eRecoveryReady === "true"), {
    timeout: 20_000, timeoutMsg: "native move probe not ready",
  });
  await browser.execute((detail) => window.dispatchEvent(new CustomEvent("e2e-recovery-operation", { detail })), {
    token, op: "move-many", sources, destination,
  });
  let response: { token?: string; error?: string; result?: { error: string | null; complete: boolean } } = {};
  await browser.waitUntil(async () => {
    response = JSON.parse(await browser.execute(() => document.documentElement.dataset.e2eRecoveryResult ?? "{}"));
    return response.token === token;
  }, { timeout: 30_000, timeoutMsg: "native presented move did not settle" });
  expect(response.error).toBeUndefined();
  return response.result!;
}

async function cue(directory: string, empty: boolean): Promise<void> {
  const entry = $(entryPathSelector(directory));
  await entry.waitForExist();
  await browser.waitUntil(async () => {
    const classes = (await $(entryPathSelector(directory)).getAttribute("class") ?? "").split(/\s+/);
    return classes.includes("empty-folder") === empty;
  }, { timeout: 20_000, timeoutMsg: `folder cue did not become ${empty ? "empty" : "nonempty"}: ${directory}` });
}

describe("native empty-folder move cues", () => {
  for (const mode of modes) {
    it(`reflects successful, partial, and reverse native moves in ${mode}`, async function () {
      this.timeout(120_000);
      const root = createNativeFixtureDirectory(`tauri-empty-cues-${mode}-`);
      const source = path.join(root, "Source");
      const archive = path.join(root, "Archive");
      const hidden = path.join(root, "Hidden-only");
      const sibling = path.join(root, "Untouched-empty");
      for (const directory of [source, archive, hidden, sibling]) fs.mkdirSync(directory);
      const original = path.join(source, "proof.txt");
      const landed = path.join(archive, "proof.txt");
      const bytes = `native ${mode} move proof\n`;
      fs.writeFileSync(original, bytes);
      fs.writeFileSync(path.join(hidden, ".secret"), "hidden");
      await navigateTo(root);
      await setHidden(false);
      await selectView(mode);
      await cue(archive, true);
      await cue(source, false);
      await cue(sibling, true);
      await cue(hidden, true);
      fs.mkdirSync(proof, { recursive: true });
      await browser.saveScreenshot(path.join(proof, `native-${mode}-before.png`));

      const partial = await move([original, path.join(source, "missing.txt")], archive);
      expect(partial.complete).toBe(false);
      expect(partial.error).toBeTruthy();
      expect(fs.readFileSync(landed, "utf8")).toBe(bytes);
      expect(fs.existsSync(original)).toBe(false);
      await cue(archive, false);
      await cue(source, true);
      await cue(sibling, true);
      await browser.saveScreenshot(path.join(proof, `native-${mode}-moved.png`));
      // Keep the original parent in place while a separate pane displays the
      // destination through the observed fresh-listing path.
      if (await $(".preview-pane").isDisplayed()) {
        await command("Toggle Preview Pane");
        await $(".preview-pane").waitForDisplayed({ reverse: true });
      }
      await command("Split Pane Right");
      await navigateTo(archive);
      const parent = $(".explorer-pane.inactive");
      await parent.$(".crumb.current").waitForDisplayed();
      await expect(parent.$(".crumb.current")).toHaveAttribute("data-path", root);
      const parentArchive = $(entryPathSelector(archive, ".explorer-pane.inactive .entry-item"));
      await parentArchive.waitForDisplayed();
      await expect(parentArchive).not.toHaveElementClass("empty-folder");
      await cue(source, true);
      await cue(sibling, true);
      await cue(hidden, true);
      const destinationFile = $(entryPathSelector(landed, ".explorer-pane.active .entry-item"));
      await destinationFile.waitForDisplayed();
      expect((await domText(`${entryPathSelector(landed, ".explorer-pane.active .entry-item")} .entry-name`)).trim()).toBe("proof.txt");
      await browser.saveScreenshot(path.join(proof, `native-${mode}-contents.png`));
      await command("Close Pane");
      await expect($(".status-path")).toHaveAttribute("title", root);
      await setHidden(true);
      await cue(hidden, false);
      await browser.saveScreenshot(path.join(proof, `native-${mode}-hidden-visible.png`));
      await setHidden(false);
      await cue(hidden, true);

      const reverse = await move([landed], source);
      expect(reverse).toEqual({ error: null, complete: true });
      expect(fs.readFileSync(original, "utf8")).toBe(bytes);
      expect(fs.existsSync(landed)).toBe(false);
      await cue(archive, true);
      await cue(source, false);
      await cue(sibling, true);
      const failed = await move([path.join(source, "missing.txt")], archive);
      expect(failed.complete).toBe(false);
      expect(failed.error).toBeTruthy();
      expect(fs.readFileSync(original, "utf8")).toBe(bytes);
      expect(fs.readdirSync(archive)).toEqual([]);
      await cue(archive, true);
      await cue(source, false);
      await browser.saveScreenshot(path.join(proof, `native-${mode}-returned.png`));
      console.log(JSON.stringify({ case: "native-empty-folder-move", mode, root, partial, reverse, failed, bytes }));
    });
  }
});
