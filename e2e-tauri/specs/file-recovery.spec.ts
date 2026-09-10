/** Real journal/executor fixture, IPC, file effects and native channel lifetime. */
import { browser, $, expect } from "@wdio/globals";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { exactApplicationPid } from "../native-process";
import { navigateTo, domTexts, entryNames } from "./helpers";

const directory = process.env.TAURI_E2E_FILE_RECOVERY_DIR;
const nativeDescribe = process.platform === "linux" && directory ? describe : describe.skip;
interface Snapshot { revision: string; items: Array<{ id: string; generation: string; actions: string[] }> }
interface Lease { sessionId: string; subscriptionId: string; channel: number; snapshot: Snapshot; registration: string }
interface Receipt { event: string; pid: number; registration?: string; channel?: number; label?: string; session?: string; token?: string; revision?: string }
interface Fixture { pid: number; id: string; source: string; target: string; root: string }
let fixture: Fixture;
let main = "";

async function operation<T>(family: "window" | "recovery", op: string, args: Record<string, unknown> = {}): Promise<T> {
  const token = crypto.randomUUID();
  await browser.waitUntil(async () => browser.execute((kind) =>
    document.documentElement.dataset[kind === "window" ? "e2eHooksReady" : "e2eRecoveryReady"] === "true", family));
  await browser.execute((kind, detail) => {
    window.dispatchEvent(new CustomEvent(`e2e-${kind}-operation`, { detail }));
  }, family, { token, op, ...args });
  let response: { token?: string; result?: T; error?: string } = {};
  await browser.waitUntil(async () => {
    const encoded = await browser.execute((kind) => document.documentElement.dataset[
      kind === "window" ? "e2eWindowResult" : "e2eRecoveryResult"] ?? "{}", family);
    // Returning an object with an `error` property is interpreted as a WebDriver
    // protocol failure by this driver. Decode the application envelope here.
    response = JSON.parse(encoded);
    return response.token === token;
  }, { timeout: 20_000, timeoutMsg: `${family} ${op} did not acknowledge ${token}` });
  if (response.error) throw new Error(response.error);
  return response.result as T;
}

function receipts(): Receipt[] {
  const text = fs.readFileSync(path.join(directory!, "channels.jsonl"), "utf8");
  // A concurrent final append may be incomplete; only complete JSONL receipts count.
  return text.slice(0, text.lastIndexOf("\n") + 1).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function rawLease(): Promise<Lease> {
  await $(".recovery-notice").waitForDisplayed(); // Automatic subscription already acknowledged.
  const lease = await operation<Lease>("recovery", "subscribe");
  const label = await browser.execute(() => document.documentElement.dataset.e2eWindowLabel);
  const received = receipts().filter(r => r.event === "received" && r.channel === lease.channel
    && r.label === label && r.session === lease.sessionId && r.token === lease.subscriptionId);
  assert.equal(received.length, 1, "exact acknowledged window/session/token must identify this receipt");
  assert.equal(received[0].session, lease.sessionId);
  assert.equal(received[0].token, lease.subscriptionId);
  assert.equal(received[0].pid, fixture.pid);
  return { ...lease, registration: received[0].registration! };
}

async function dropped(lease: Lease): Promise<void> {
  await browser.waitUntil(() => receipts().some(r => r.event === "dropped" && r.registration === lease.registration), {
    timeout: 10_000, timeoutMsg: `native Channel ${lease.channel} remained retained`,
  });
  assert.equal(receipts().filter(r => r.event === "dropped" && r.registration === lease.registration).length, 1);
  const label = receipts().find(r => r.event === "received" && r.registration === lease.registration)!.label;
  assert.ok(!receipts().some(r => r.event === "unsubscribe" && r.label === label && r.token === lease.subscriptionId
    && r.session === lease.sessionId), "raw lease must retire without frontend unsubscribe");
}

async function verifyFreshDelivery(lease: Lease, retired: Lease): Promise<void> {
  const oldSends = receipts().filter(r => r.event === "send" && r.registration === retired.registration).length;
  // Inspection reclaims the actual OS owner and advances its durable generation.
  const changed = await operation<Snapshot>("recovery", "inspect", { id: fixture.id });
  assert.ok(BigInt(changed.revision) > BigInt(lease.snapshot.revision));
  const item = changed.items.find(item => item.id === fixture.id)!;
  assert.ok(BigInt(item.generation) > BigInt(lease.snapshot.items.find(item => item.id === fixture.id)!.generation));
  await browser.waitUntil(async () => browser.execute((expected) => {
    const received = JSON.parse(document.documentElement.dataset.e2eRecoverySnapshot ?? "null");
    return received?.subscriptionId === expected.subscriptionId && received.snapshot.revision === expected.revision
      && received.snapshot.items.some((item: { id: string; generation: string }) =>
        item.id === expected.id && item.generation === expected.generation);
  }, { revision: changed.revision, id: item.id, generation: item.generation, subscriptionId: lease.subscriptionId }), {
    timeoutMsg: "replacement channel did not receive the real durable transition",
  });
  assert.equal(receipts().filter(r => r.event === "send" && r.registration === retired.registration).length, oldSends);
  assert.ok(receipts().some(r => r.event === "send" && r.registration === lease.registration && r.revision === changed.revision));
  assert.equal(exactApplicationPid(), fixture.pid);
}

async function historyThroughExplorer(direction: "undo" | "redo"): Promise<string | null> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => window.dispatchEvent(new CustomEvent("e2e-file-op", { detail })), { token, op: direction });
  let response: { token?: string; error?: string | null } = {};
  await browser.waitUntil(async () => {
    response = JSON.parse(await browser.execute(() => document.documentElement.dataset.e2eFileOperationResult ?? "{}"));
    return response.token === token;
  }, { timeoutMsg: `Explorer ${direction} did not finish` });
  return response.error ?? null;
}

async function renameThroughExplorer(source: string, name: string): Promise<string> {
  await navigateTo(path.dirname(source));
  await browser.waitUntil(async () => (await entryNames()).includes(path.basename(source)));
  const token = crypto.randomUUID();
  await browser.execute((detail) => window.dispatchEvent(new CustomEvent("e2e-file-op", { detail })), {
    token, op: "rename", path: source, name,
  });
  let response: { token?: string; error?: string } = {};
  await browser.waitUntil(async () => {
    response = JSON.parse(await browser.execute(() => document.documentElement.dataset.e2eFileOperationResult ?? "{}"));
    return response.token === token;
  }, { timeoutMsg: "Explorer rename did not finish after completed recovery" });
  assert.ok(!response.error, response.error);
  const target = path.join(path.dirname(source), name);
  assert.equal(fs.readFileSync(target, "utf8"), "native original payload\n");
  assert.ok(!fs.existsSync(source));
  await browser.waitUntil(async () => {
    const names = await entryNames();
    return names.includes(name) && !names.includes(path.basename(source));
  }, { timeoutMsg: "Explorer listing did not reflect the completed rename" });
  return target;
}

nativeDescribe("File recovery native acceptance", () => {
  before(async () => {
    await browser.waitUntil(() => fs.existsSync(path.join(directory!, "fixture.json")));
    fixture = JSON.parse(fs.readFileSync(path.join(directory!, "fixture.json"), "utf8"));
    assert.equal(exactApplicationPid(), fixture.pid);
    main = await browser.getWindowHandle();
    await navigateTo(path.dirname(fixture.target));
  });

  after(async () => {
    for (const handle of await browser.getWindowHandles()) {
      if (handle === main) continue;
      await browser.switchToWindow(handle);
      await browser.closeWindow();
    }
    await browser.switchToWindow(main);
  });

  it("restores the original through real IPC and retains the independent copied payload", async () => {
    assert.equal(fs.readFileSync(fixture.target, "utf8"), "native copied payload\n");
    assert.equal(fs.readFileSync(path.join(fixture.root, "original"), "utf8"), "native original payload\n");
    await $(".recovery-notice").click();
    await $(".recovery-dialog").waitForDisplayed();
    await $("[data-recovery-inspect]").click();
    await $(".item-actions .primary").waitForEnabled();
    await $(".item-actions .primary").click();
    await browser.waitUntil(() => fs.readFileSync(fixture.target, "utf8") === "native original payload\n");
    assert.equal(fs.readFileSync(path.join(fixture.root, "publication"), "utf8"), "native copied payload\n");
    assert.equal(fs.readFileSync(fixture.source, "utf8"), "native copied payload\n");
    await browser.waitUntil(async () => (await domTexts(".recovery-item > p")).some(text => text.includes("original has been restored")));
    await expect($(".item-actions .primary")).not.toExist();
    await $("[data-recovery-inspect]").click();
    await browser.waitUntil(async () => (await domTexts(".inspection dd")).includes(fixture.target));
    const retained = await browser.execute(() => Array.from(document.querySelectorAll(".inspection div"))
      .find(row => row.querySelector("dt")?.textContent === "Artifacts")?.querySelector("dd")?.textContent);
    assert.ok(retained && fs.existsSync(retained), "Retained location must identify the surviving recovery artifacts");
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-file-recovery-restored.png");
    await $('[aria-label="Close file recovery"]').click();
    await $(".recovery-dialog").waitForDisplayed({ reverse: true });
    const renamed = await renameThroughExplorer(fixture.target, "restored-renamed.txt");
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-recovery-restored-editable.png");
    await renameThroughExplorer(renamed, path.basename(fixture.target));
    assert.equal(fs.readFileSync(path.join(fixture.root, "publication"), "utf8"), "native copied payload\n");
  });

  it("journals an overwrite, cycles native Undo/Redo, then restores through the recovery dialog", async () => {
    const base = path.dirname(fixture.target);
    const sourceDirectory = path.join(base, "forward-source");
    const destination = path.join(base, "forward-target");
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(destination);
    const source = path.join(sourceDirectory, "live-copy.txt");
    const target = path.join(destination, "live-copy.txt");
    fs.writeFileSync(source, "production copied bytes\n");
    fs.writeFileSync(target, "production original bytes\n");
    await navigateTo(destination);
    const result = await operation<{ ok: boolean; replacement?: { id: string }; warning?: string; error?: string }>(
      "recovery", "copy", { source, destination });
    assert.ok(result.ok, result.error);
    assert.ok(result.replacement?.id);
    assert.equal(result.warning, undefined, "successful native history no longer warns that overwrite Undo is unavailable");
    assert.equal(fs.readFileSync(target, "utf8"), "production copied bytes\n");
    assert.equal(fs.readFileSync(source, "utf8"), "production copied bytes\n");
    for (let cycle = 0; cycle < 2; cycle++) {
      // A real recovery inspection changes ownership generation between history
      // effects; native semantic history must remain valid.
      await operation("recovery", "inspect", { id: result.replacement!.id });
      assert.equal(await historyThroughExplorer("undo"), null);
      assert.equal(fs.readFileSync(target, "utf8"), "production original bytes\n");
      await browser.waitUntil(async () => (await domTexts(".toast")).some(text => text.includes("Undo: Replaced live-copy.txt")));
      await operation("recovery", "inspect", { id: result.replacement!.id });
      assert.equal(await historyThroughExplorer("redo"), null);
      assert.equal(fs.readFileSync(target, "utf8"), "production copied bytes\n");
      await browser.waitUntil(async () => (await domTexts(".toast")).some(text => text.includes("Redo: Replaced live-copy.txt")));
    }
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-production-copy-redone.png");
    await $(".recovery-notice").click();
    await $(".recovery-dialog").waitForDisplayed();
    // This record was created by copy_entry, not by the launch fixture. Its
    // appearance also proves worker-side inventory publication reached the UI.
    const inspect = $(`[data-recovery-inspect="${result.replacement!.id}"]`);
    await inspect.waitForDisplayed();
    await inspect.click();
    const restore = $(".item-actions .primary");
    await restore.waitForEnabled();
    await restore.click();
    await browser.waitUntil(() => fs.readFileSync(target, "utf8") === "production original bytes\n");
    const root = fs.readdirSync(destination).find(name => name.startsWith(".tauri-explorer-recovery-"));
    assert.ok(root);
    assert.equal(fs.readFileSync(path.join(destination, root, "publication"), "utf8"), "production copied bytes\n");
    assert.equal(fs.readFileSync(source, "utf8"), "production copied bytes\n");
    await browser.waitUntil(async () => (await domTexts(".recovery-item > p")).filter(text => text.includes("original has been restored")).length === 2);
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-production-copy-restored.png");
    await $('[aria-label="Close file recovery"]').click();
    await $(".recovery-dialog").waitForDisplayed({ reverse: true });
  });

  it("drops raw channels on reload and fences the previous renderer across two generations", async () => {
    await browser.refresh();
    await navigateTo(path.dirname(fixture.target));
    let lease = await rawLease();
    for (let cycle = 0; cycle < 2; cycle++) {
      const previous = lease;
      await browser.refresh();
      await dropped(previous);
      await navigateTo(path.dirname(fixture.target));
      assert.equal(await browser.getWindowHandle(), main);
      lease = await rawLease();
      assert.ok(BigInt(lease.sessionId) > BigInt(previous.sessionId));
      await assert.rejects(operation("recovery", "subscribe", {
        sessionId: previous.sessionId, subscriptionId: previous.subscriptionId,
      }), /renderer was replaced/);
      await operation("recovery", "unsubscribe", { sessionId: previous.sessionId, subscriptionId: previous.subscriptionId });
      await verifyFreshDelivery(lease, previous);
    }
  });

  it("drops a destroyed child's raw channel while the surviving window still receives native updates", async () => {
    // A fresh main realm restores its normal low-token UI subscription first.
    await browser.refresh();
    await navigateTo(path.dirname(fixture.target));
    const mainLease = await rawLease();
    const child = await operation<{ label: string }>("window", "fresh-open", { target: path.dirname(fixture.target) });
    let childHandle = "";
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        if (handle === main) continue;
        await browser.switchToWindow(handle);
        if (await browser.execute(() => document.documentElement.dataset.e2eWindowLabel) === child.label) {
          childHandle = handle;
          return true;
        }
      }
      return false;
    });
    const childLease = await rawLease();
    await browser.execute(() => window.dispatchEvent(new CustomEvent("e2e-window-operation", {
      detail: { token: "destroy-recovery-owner", op: "native-destroy" },
    })));
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(childHandle));
    await browser.switchToWindow(main);
    await dropped(childLease);
    await verifyFreshDelivery(mainLease, childLease);
    assert.ok(!receipts().some(r => r.event === "dropped" && r.registration === mainLease.registration));
    assert.equal(fs.readFileSync(fixture.target, "utf8"), "native original payload\n");
  });

  (process.env.TAURI_E2E_HISTORY_GATE_DIR ? it : it.skip)("settles admitted replacement Undo after its window is destroyed without leaking local history", async () => {
    const gateDirectory = process.env.TAURI_E2E_HISTORY_GATE_DIR!;
    const base = path.dirname(fixture.target);
    const sourceDirectory = path.join(base, "detached-source");
    const destination = path.join(base, "detached-target");
    fs.mkdirSync(sourceDirectory);
    fs.mkdirSync(destination);
    const source = path.join(sourceDirectory, "detached.txt");
    const target = path.join(destination, "detached.txt");
    fs.writeFileSync(source, "detached copied bytes\n");
    fs.writeFileSync(target, "detached original bytes\n");
    await browser.refresh();
    await navigateTo(destination);
    const mainLease = await rawLease();
    type Summary = { undoId: number | null; redoId: number | null; busy: boolean };
    const summary = async (): Promise<Summary> => JSON.parse(await browser.execute(() => document.documentElement.dataset.e2eHistorySummary ?? "{}"));
    const before = await summary();
    const child = await operation<{ label: string }>("window", "fresh-open", { target: destination });
    let childHandle = "";
    await browser.waitUntil(async () => {
      for (const handle of await browser.getWindowHandles()) {
        if (handle === main) continue;
        await browser.switchToWindow(handle);
        if (await browser.execute(() => document.documentElement.dataset.e2eWindowLabel) === child.label) {
          childHandle = handle;
          return true;
        }
      }
      return false;
    });
    const childLease = await rawLease();
    const copied = await operation<{ ok: boolean; replacement?: { id: string }; error?: string }>("recovery", "copy", { source, destination });
    assert.ok(copied.ok, copied.error);
    const id = copied.replacement!.id;
    const childSummary = await summary();
    assert.ok(childSummary.undoId !== null);
    const entryId = childSummary.undoId!;
    const inspected = await operation<Snapshot>("recovery", "inspect", { id });
    const priorGeneration = inspected.items.find(item => item.id === id)!.generation;
    const token = crypto.randomUUID();
    const stem = `${entryId}-undo`;
    const release = path.join(gateDirectory, `${stem}.${token}.release`);
    fs.writeFileSync(path.join(gateDirectory, `${stem}.arm`), JSON.stringify({ token }));
    try {
      // Dispatch once and deliberately destroy the caller before any reply.
      await browser.execute(detail => window.dispatchEvent(new CustomEvent("e2e-history-operation", { detail })), {
        token: crypto.randomUUID(), op: "execute", direction: "undo", expectedEntryId: entryId,
      });
      const accepted = path.join(gateDirectory, `${stem}.accepted.json`);
      await browser.waitUntil(() => fs.existsSync(accepted));
      assert.deepEqual(JSON.parse(fs.readFileSync(accepted, "utf8")), { token, entryId, direction: "undo", pid: fixture.pid });
      assert.equal(fs.readFileSync(target, "utf8"), "detached copied bytes\n");
      await browser.execute(detail => window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail })), {
        token: crypto.randomUUID(), op: "native-destroy",
      });
      await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(childHandle));
      await browser.switchToWindow(main);
      await dropped(childLease);
      await browser.waitUntil(async () => (await domTexts(".size-cell")).includes("22 bytes"), {
        timeoutMsg: "main listing did not observe the copied bytes before detached Undo",
      });
      // Observe actual DOM reconciliation, excluding subsequent WebDriver polls
      // and recovery inspection round trips from the latency measurement.
      await browser.execute((directoryPath: string) => {
        const element = document.documentElement;
        const readReceipt = () => JSON.parse(element.dataset.e2eDirectoryWatcherReceipts ?? "{}")[directoryPath];
        const beforeCount = readReceipt()?.mutationCount ?? 0;
        const armedAt = Date.now();
        let receivedAt: number | null = null;
        let visibleAt: number | null = null;
        let observedAt: number | null = null;
        const observer = new MutationObserver(() => {
          const receipt = readReceipt();
          if (receivedAt === null && receipt?.mutationCount > beforeCount && receipt.mutationObservedAt >= armedAt) {
            receivedAt = Date.now();
            observedAt = receipt.mutationObservedAt;
          }
          const row = [...document.querySelectorAll(".entry-item")].find(entry =>
            entry.querySelector(".entry-name")?.textContent?.trim() === "detached.txt");
          if (visibleAt === null && row?.querySelector(".size-cell")?.textContent?.trim() === "24 bytes") {
            visibleAt = Date.now();
          }
          if (receivedAt !== null && visibleAt !== null) {
            observer.disconnect();
            element.dataset.e2eMutationRefreshMeasurement = JSON.stringify({ armedAt, receivedAt, visibleAt, observedAt });
          }
        });
        delete element.dataset.e2eMutationRefreshMeasurement;
        observer.observe(element, { subtree: true, attributes: true, childList: true, characterData: true });
      }, destination);
      const releaseStartedAt = Date.now();
      fs.writeFileSync(release, token);
      await browser.waitUntil(() => fs.readFileSync(target, "utf8") === "detached original bytes\n");
      await browser.waitUntil(async () => browser.execute(expected => {
        const current = JSON.parse(document.documentElement.dataset.e2eRecoverySnapshot ?? "null");
        return current?.subscriptionId === expected.subscriptionId && current.snapshot.items.some((item: { id: string; generation: string }) =>
          item.id === expected.id && BigInt(item.generation) > BigInt(expected.generation));
      }, { subscriptionId: mainLease.subscriptionId, id, generation: priorGeneration }));
      await browser.waitUntil(async () => !(await summary()).busy);
      const after = await summary();
      assert.equal(after.undoId, before.undoId, "retired child history must not enter main Undo");
      assert.equal(after.redoId, before.redoId, "retired child history must not enter main Redo");
      const root = fs.readdirSync(destination).find(name => name.startsWith(".tauri-explorer-recovery-"))!;
      assert.equal(fs.readFileSync(path.join(destination, root, "publication"), "utf8"), "detached copied bytes\n");
      assert.equal(fs.readFileSync(source, "utf8"), "detached copied bytes\n");
      const released = JSON.parse(fs.readFileSync(path.join(gateDirectory, `${stem}.released.json`), "utf8"));
      assert.deepEqual(released, { token, status: "released" });
      await browser.waitUntil(async () => (await domTexts(".size-cell")).includes("24 bytes"), {
        timeoutMsg: "surviving Explorer listing retained pre-Undo metadata",
      });
      await browser.waitUntil(async () => browser.execute(() => !!document.documentElement.dataset.e2eMutationRefreshMeasurement), {
        timeoutMsg: "no application-side mutation receipt and visible row reconciliation",
      });
      const measurement = JSON.parse(await browser.execute(() => document.documentElement.dataset.e2eMutationRefreshMeasurement!));
      assert.ok(measurement.observedAt >= releaseStartedAt, "receipt must cover this released Undo, not an older event");
      console.log("Detached Undo refresh timing", JSON.stringify({ ...measurement, releaseStartedAt,
        releaseToVisibleMs: measurement.visibleAt - releaseStartedAt,
        receiptToVisibleMs: measurement.visibleAt - measurement.receivedAt,
      }));
      const recovered = await operation<Snapshot>("recovery", "inspect", { id });
      const inspectedItem = recovered.items.find(item => item.id === id);
      assert.ok(inspectedItem && BigInt(inspectedItem.generation) > BigInt(priorGeneration));
      await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-replacement-detached-undo.png");
    } finally {
      if (!fs.existsSync(release)) fs.writeFileSync(release, token);
    }
  });

  it("copies ordinary and replacement items as one native Undo/Redo operation", async () => {
    const base = fs.mkdtempSync(path.join(directory!, "ordered-copy-"));
    const sources = path.join(base, "sources");
    const destination = path.join(base, "destination");
    fs.mkdirSync(sources); fs.mkdirSync(destination);
    fs.writeFileSync(path.join(sources, "ordinary.txt"), "ordinary copy bytes");
    fs.writeFileSync(path.join(sources, "replace.txt"), "replacement copy bytes");
    fs.writeFileSync(path.join(destination, "replace.txt"), "original destination bytes");
    await navigateTo(destination);
    const token = crypto.randomUUID();
    await browser.execute((detail) => window.dispatchEvent(new CustomEvent("e2e-recovery-operation", { detail })), {
      token, op: "copy-many", sources: [path.join(sources, "ordinary.txt"), path.join(sources, "replace.txt")], destination,
    });
    await $(".conflict-dialog").waitForDisplayed();
    assert.equal(fs.readFileSync(path.join(destination, "ordinary.txt"), "utf8"), "ordinary copy bytes");
    await $(".conflict-dialog .btn-primary").click();
    await $(".conflict-dialog").waitForDisplayed({ reverse: true });
    let reply: {token?: string; result?: string | null; error?: string} = {};
    await browser.waitUntil(async () => {
      reply = JSON.parse(await browser.execute(() => document.documentElement.dataset.e2eRecoveryResult ?? "{}"));
      return reply.token === token;
    }, { timeout: 20_000 });
    assert.equal(reply.error, undefined); assert.equal(reply.result, null);
    fs.rmSync(sources, { recursive: true });
    for (let cycle = 0; cycle < 2; cycle++) {
      assert.equal(await historyThroughExplorer("undo"), null);
      assert.ok(!fs.existsSync(path.join(destination, "ordinary.txt")), "one Undo must remove the ordinary prefix");
      assert.equal(fs.readFileSync(path.join(destination, "replace.txt"), "utf8"), "original destination bytes");
      assert.equal(await historyThroughExplorer("redo"), null);
      assert.equal(fs.readFileSync(path.join(destination, "ordinary.txt"), "utf8"), "ordinary copy bytes");
      assert.equal(fs.readFileSync(path.join(destination, "replace.txt"), "utf8"), "replacement copy bytes");
    }
    await browser.waitUntil(async () => (await entryNames()).includes("ordinary.txt"));
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-ordered-copy-redone.png");
  });

  it("conflict Cancel leaves the copied prefix undoable and never starts the suffix", async () => {
    const base = fs.mkdtempSync(path.join(directory!, "cancel-copy-"));
    const sources = path.join(base, "sources");
    const destination = path.join(base, "destination");
    fs.mkdirSync(sources); fs.mkdirSync(destination);
    for (const name of ["prefix.txt", "conflict.txt", "suffix.txt"]) fs.writeFileSync(path.join(sources, name), `source ${name}`);
    fs.writeFileSync(path.join(destination, "conflict.txt"), "keep original");
    await navigateTo(destination);
    const token = crypto.randomUUID();
    await browser.execute((detail) => window.dispatchEvent(new CustomEvent("e2e-recovery-operation", { detail })), {
      token, op: "copy-many", sources: ["prefix.txt", "conflict.txt", "suffix.txt"].map(name => path.join(sources, name)), destination,
    });
    await $(".conflict-dialog").waitForDisplayed();
    await $(".conflict-dialog .btn-cancel").click();
    await $(".conflict-dialog").waitForDisplayed({ reverse: true });
    await browser.waitUntil(async () => {
      const response = JSON.parse(await browser.execute(() => document.documentElement.dataset.e2eRecoveryResult ?? "{}"));
      if (response.token !== token) return false;
      assert.equal(response.error, undefined); assert.equal(response.result, null);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(destination, "prefix.txt"), "utf8"), "source prefix.txt");
    assert.equal(fs.readFileSync(path.join(destination, "conflict.txt"), "utf8"), "keep original");
    assert.ok(!fs.existsSync(path.join(destination, "suffix.txt")));
    assert.equal(await historyThroughExplorer("undo"), null);
    assert.ok(!fs.existsSync(path.join(destination, "prefix.txt")));
    assert.equal(fs.readFileSync(path.join(destination, "conflict.txt"), "utf8"), "keep original");
    await browser.waitUntil(async () => !(await entryNames()).includes("prefix.txt"));
    await browser.saveScreenshot("screenshots/refactor/repo-health-cleanup/native-ordered-copy-cancelled.png");
  });

});
