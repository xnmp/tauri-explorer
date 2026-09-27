/** Real forward moves and explicit two-volume retirement through the recovery UI. */
import { browser, $, expect } from "@wdio/globals";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { FileRecoverySnapshot } from "../../src/lib/domain/file-recovery";
import { gatedDescribe } from "./gated-describe";
import { navigateTo } from "./helpers";

const sourceBase = process.env.TAURI_E2E_MOVE_SOURCE_DIR;
const targetBase = process.env.TAURI_E2E_MOVE_TARGET_DIR;
const proof = "screenshots/feat/durable-move-retirement";

async function operation<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const token = crypto.randomUUID();
  await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.e2eRecoveryReady === "true"));
  await browser.execute(detail => window.dispatchEvent(new CustomEvent("e2e-recovery-operation", { detail })), { token, op, ...args });
  let response: { token?: string; result?: T; error?: string } = {};
  await browser.waitUntil(async () => {
    response = JSON.parse(await browser.execute(() => document.documentElement.dataset.e2eRecoveryResult ?? "{}"));
    return response.token === token;
  }, { timeout: 20_000, timeoutMsg: `${op} did not acknowledge ${token}` });
  assert.ok(!response.error, response.error);
  return response.result as T;
}

const inventory = () => operation<FileRecoverySnapshot>("list");
const roots = (directory: string) => fs.readdirSync(directory)
  .filter(name => name.startsWith(".tauri-explorer-recovery-"))
  .map(name => path.join(directory, name));

async function openRecovery(id: string): Promise<void> {
  await $(".toast").waitForExist({ reverse: true });
  await $(".recovery-notice").click();
  await $(".recovery-dialog").waitForDisplayed();
  await $(`[data-recovery-inspect="${id}"]`).click();
  // aria-busy tracks loading and resolution, not inspection. Reclaim skips a
  // record whose inspection still holds its claim, so wait for the inspection
  // itself to settle before any later action reaches the backend.
  await browser.waitUntil(async () => browser.execute(target => Boolean(document
    .querySelector(`[data-recovery-inspect="${target}"]`)?.closest(".recovery-item")
    ?.querySelector(".inspection, .inspection-error")), id),
  { timeoutMsg: `inspection of ${id} did not settle` });
  await $(".recovery-dialog[aria-busy='false']").waitForExist();
}

async function closeRecovery(): Promise<void> {
  await $('[aria-label="Close file recovery"]').click();
  await $(".recovery-dialog").waitForDisplayed({ reverse: true });
}

async function moveFixture(name: string, directory: boolean) {
  const sourceDirectory = fs.mkdtempSync(path.join(sourceBase!, `${name}-`));
  const destination = fs.mkdtempSync(path.join(targetBase!, `${name}-`));
  const source = path.join(sourceDirectory, directory ? "album" : "photo.txt");
  const target = path.join(destination, path.basename(source));
  const published = "published move bytes\n";
  const original = "displaced original bytes\n";
  if (directory) {
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, "photo.txt"), published);
    fs.writeFileSync(path.join(target, "original.txt"), original);
  } else {
    fs.writeFileSync(source, published);
    fs.writeFileSync(target, original);
  }
  assert.notEqual(fs.statSync(sourceDirectory).dev, fs.statSync(destination).dev, "fixture must exercise a real cross-filesystem move");
  await navigateTo(destination);
  const result = await operation<{ ok: boolean; error?: string }>("move", { source, destination });
  assert.ok(result.ok, result.error);
  assert.ok(!fs.existsSync(source), "completed move must remove the public source");
  assert.equal(fs.readFileSync(directory ? path.join(target, "photo.txt") : target, "utf8"), published);
  const snapshot = await inventory();
  const item = snapshot.items.find(item => item.originalPath === source);
  assert.ok(item, "the production move must publish a durable recovery record");
  const retained = [...roots(sourceDirectory), ...roots(destination)];
  assert.equal(retained.length, 2, "both the parked source and displaced target must be retained");
  return { sourceDirectory, destination, source, target, published, original, retained, id: item.id };
}

gatedDescribe("Durable move retirement", [
  [process.platform === "linux", "Linux"],
  [Boolean(sourceBase), "TAURI_E2E_MOVE_SOURCE_DIR"],
  [Boolean(targetBase), "TAURI_E2E_MOVE_TARGET_DIR"],
], () => {
  before(async () => {
    fs.mkdirSync(proof, { recursive: true });
    await browser.setWindowSize(1200, 900);
  });
  afterEach(async () => {
    if (await $(".recovery-dialog").isDisplayed()) await closeRecovery();
  });

  for (const directory of [false, true]) {
    it(`discards both retained roots of a cross-volume ${directory ? "directory" : "file"} without changing its publication`, async () => {
      const fixture = await moveFixture(directory ? "directory" : "file", directory);
      await openRecovery(fixture.id);
      // Reclaim measures completed records, but must preserve their Undo until
      // the user explicitly discards them.
      await $("[data-recovery-reclaim]").click();
      await browser.waitUntil(async () => (await inventory()).items
        .some(item => item.id === fixture.id && item.retainedBytes !== null));
      for (const root of fixture.retained) assert.ok(fs.existsSync(root));
      await $(`[data-recovery-inspect="${fixture.id}"]`).click();
      const before = await inventory();
      const item = before.items.find(item => item.id === fixture.id)!;
      await $(`[data-recovery-discard="${fixture.id}"]`).waitForDisplayed();
      assert.ok(BigInt(item.retainedBytes!) >= BigInt(fixture.published.length + fixture.original.length));
      const usageBefore = await $("[data-recovery-usage]").getText();
      await $(`[data-recovery-discard="${fixture.id}"]`).click();
      await expect($(".discard-confirmation")).toHaveText(expect.stringContaining("removes recovery and Undo"));
      await browser.saveScreenshot(`${proof}/native-${directory ? "directory" : "file"}-before-discard.png`);
      await $(".discard-confirmation .danger").click();
      await browser.waitUntil(async () => !(await inventory()).items.some(item => item.id === fixture.id));
      for (const root of fixture.retained) assert.ok(!fs.existsSync(root), `retained root survived: ${root}`);
      assert.ok(!fs.existsSync(fixture.source));
      assert.equal(fs.readFileSync(directory ? path.join(fixture.target, "photo.txt") : fixture.target, "utf8"), fixture.published);
      const after = await inventory();
      assert.equal(after.storage.records, before.storage.records - 1);
      assert.equal(BigInt(after.storage.usedBytes), BigInt(before.storage.usedBytes) - BigInt(item.retainedBytes!));
      await browser.waitUntil(async () => (await $("[data-recovery-usage]").getText()) !== usageBefore);
      await browser.saveScreenshot(`${proof}/native-${directory ? "directory" : "file"}-after-discard.png`);
      await closeRecovery();
    });
  }

  it("preserves both recovery roots and a changed publication when reclaiming space", async () => {
    const fixture = await moveFixture("changed", false);
    fs.writeFileSync(fixture.target, "external changed publication\n");
    await openRecovery(fixture.id);
    const before = await inventory();
    await expect($(".recovery-item .status")).toHaveText(/attention/i);
    await expect($(`[data-recovery-discard="${fixture.id}"]`)).not.toExist();
    await $("[data-recovery-reclaim]").click();
    // This previously unmeasured record must be measured by the actual reclaim
    // request. An idle DOM alone could still describe the pre-click render.
    await browser.waitUntil(async () => {
      const current = await inventory();
      return BigInt(current.revision) > BigInt(before.revision)
        && current.items.some(item => item.id === fixture.id && item.retainedBytes !== null);
    }, { timeoutMsg: "Reclaim did not publish measurement of the unresolved move" });
    await $(".recovery-dialog[aria-busy='false']").waitForExist();
    const after = await inventory();
    assert.ok(after.items.some(item => item.id === fixture.id), "unresolved record must survive reclaim");
    assert.equal(after.storage.records, before.storage.records);
    for (const root of fixture.retained) assert.ok(fs.existsSync(root));
    assert.equal(fs.readFileSync(path.join(roots(fixture.sourceDirectory)[0], "parked"), "utf8"), fixture.published);
    assert.equal(fs.readFileSync(path.join(roots(fixture.destination)[0], "original"), "utf8"), fixture.original);
    assert.equal(fs.readFileSync(fixture.target, "utf8"), "external changed publication\n");
    await $(`[data-recovery-inspect="${fixture.id}"]`).click();
    await expect($(".recovery-item .status")).toHaveText(/attention/i);
    await expect($(`[data-recovery-discard="${fixture.id}"]`)).not.toExist();
    await browser.saveScreenshot(`${proof}/native-unresolved-preserved.png`);
    await closeRecovery();
  });
});
