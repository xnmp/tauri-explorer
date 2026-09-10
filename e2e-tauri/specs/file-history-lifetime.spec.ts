/** Native shared-history admission and renderer-lifetime acceptance.
 * Rename effects are precreated fixtures: this proves inverse ownership, not
 * atomic admission of a forward mutation and its subsequent history push. */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exactApplicationPid } from "../native-process";
import { entryNames, navigateTo } from "./helpers";

type Direction = "undo" | "redo";
type RenameAction = { type: "rename"; path: string; oldName: string; newName: string };
interface HistorySummary { revision: number; undoId: number | null; redoId: number | null; stackSize: number; busy: boolean }
interface HistoryReply { summary: HistorySummary; action?: RenameAction; error?: string }
interface HistoryEnvelope { token: string; result?: HistoryReply; error?: string }
interface GateAccepted { token: string; entryId: number; direction: Direction; pid: number }
interface GateReleased { token: string; status: "released" | "timeout" }
interface ArmedGate { entryId: number; direction: Direction; token: string; arm: string; accepted: string; release: string; released: string }

const gateDirectory = process.env.TAURI_E2E_HISTORY_GATE_DIR ?? "";
const gateArtifacts = new Set<string>();
let scratch = "";
let mainHandle = "";
let childHandle = "";
let applicationPid = 0;

async function startHistoryOperation(
  op: "push" | "execute" | "clear",
  fields: { action?: RenameAction; shared?: boolean; direction?: Direction; expectedEntryId?: number } = {},
): Promise<string> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => {
    delete document.documentElement.dataset.e2eHistoryResult;
    window.dispatchEvent(new CustomEvent("e2e-history-operation", { detail }));
  }, { token, op, ...fields });
  return token;
}

async function waitForHistoryResult(token: string): Promise<HistoryEnvelope> {
  let envelope: HistoryEnvelope | undefined;
  await browser.waitUntil(async () => {
    const encoded = await browser.execute(() => document.documentElement.dataset.e2eHistoryResult);
    if (!encoded) return false;
    envelope = JSON.parse(encoded) as HistoryEnvelope;
    return envelope.token === token;
  }, { timeout: 30_000, timeoutMsg: `history operation ${token} did not finish` });
  return envelope!;
}

function unwrap(envelope: HistoryEnvelope): HistoryReply {
  if (envelope.error || !envelope.result) throw new Error(envelope.error ?? "History probe returned no result");
  return envelope.result;
}

async function historyOperation(
  op: "push" | "execute" | "clear",
  fields: Parameters<typeof startHistoryOperation>[1] = {},
): Promise<HistoryReply> {
  return unwrap(await waitForHistoryResult(await startHistoryOperation(op, fields)));
}

async function freshWindow(target: string): Promise<{ kind: string; label: string }> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => {
    delete document.documentElement.dataset.e2eWindowResult;
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail }));
  }, { token, op: "fresh-open", target });
  let envelope: { token?: string; result?: { kind: string; label: string }; error?: string } = {};
  await browser.waitUntil(async () => {
    envelope = await browser.execute(() => JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
    return envelope.token === token;
  }, { timeout: 25_000, timeoutMsg: "fresh-open did not finish" });
  if (envelope.error || !envelope.result) throw new Error(envelope.error ?? "fresh-open returned no window");
  return envelope.result;
}

async function switchToLabel(label: string): Promise<string> {
  let selected = "";
  await browser.waitUntil(async () => {
    for (const handle of await browser.getWindowHandles()) {
      await browser.switchToWindow(handle);
      if (await browser.execute(() => document.documentElement.dataset.e2eWindowLabel) === label) {
        selected = handle;
        return true;
      }
    }
    return false;
  }, { timeout: 20_000, timeoutMsg: `native window ${label} did not become ready` });
  return selected;
}

async function waitForHistoryReady(): Promise<void> {
  await browser.waitUntil(async () => await browser.execute(() =>
    document.documentElement.dataset.e2eHistoryReady === "true"
    && document.documentElement.dataset.e2eHistorySummary !== undefined), {
    timeout: 20_000,
    timeoutMsg: "native file history subscription did not become ready",
  });
}

async function currentSummary(): Promise<HistorySummary> {
  const encoded = await browser.execute(() => document.documentElement.dataset.e2eHistorySummary);
  if (!encoded) throw new Error("Current window has no passive history summary");
  return JSON.parse(encoded) as HistorySummary;
}

async function waitForSummary(predicate: (summary: HistorySummary) => boolean, context: string): Promise<HistorySummary> {
  let observed: HistorySummary | undefined;
  await browser.waitUntil(async () => {
    observed = await currentSummary();
    return predicate(observed);
  }, { timeout: 20_000, timeoutMsg: `history summary did not ${context}` });
  return observed!;
}

async function clearBothHistories(): Promise<void> {
  await browser.switchToWindow(mainHandle);
  expect((await historyOperation("clear")).error).toBeUndefined();
  await browser.switchToWindow(childHandle);
  expect((await historyOperation("clear")).error).toBeUndefined();
  await waitForSummary((s) => s.undoId === null && s.redoId === null && !s.busy, "clear the child");
  await browser.switchToWindow(mainHandle);
  await waitForSummary((s) => s.undoId === null && s.redoId === null && !s.busy, "clear the main window");
}

function renameFixture(stem: string, contents: string) {
  const original = path.join(scratch, `${stem}-original.txt`);
  const renamed = path.join(scratch, `${stem}-renamed.txt`);
  fs.writeFileSync(original, contents);
  fs.renameSync(original, renamed);
  const action: RenameAction = {
    type: "rename", path: renamed, oldName: path.basename(original), newName: path.basename(renamed),
  };
  return { action, original, renamed };
}

function expectOnlyPath(expected: string, absent: string, contents: string): void {
  expect(fs.existsSync(expected)).toBe(true);
  expect(fs.readFileSync(expected, "utf8")).toBe(contents);
  expect(fs.existsSync(absent)).toBe(false);
  expect([expected, absent].filter((candidate) => fs.existsSync(candidate))).toHaveLength(1);
}

function armGate(entryId: number, direction: Direction): ArmedGate {
  const token = crypto.randomUUID();
  const stem = `${entryId}-${direction}`;
  const gate = {
    entryId, direction, token,
    arm: path.join(gateDirectory, `${stem}.arm`),
    accepted: path.join(gateDirectory, `${stem}.accepted.json`),
    release: path.join(gateDirectory, `${stem}.${token}.release`),
    released: path.join(gateDirectory, `${stem}.released.json`),
  };
  const temporary = path.join(gateDirectory, `${stem}.${token}.tmp`);
  for (const artifact of [gate.arm, gate.accepted, gate.release, gate.released, temporary]) {
    gateArtifacts.add(artifact);
    if (fs.existsSync(artifact)) throw new Error(`history gate artifact already exists: ${artifact}`);
  }
  fs.writeFileSync(temporary, JSON.stringify({ token }));
  fs.renameSync(temporary, gate.arm);
  return gate;
}

async function waitForJson<T>(file: string, context: string): Promise<T> {
  let value: T | undefined;
  await browser.waitUntil(() => {
    if (!fs.existsSync(file)) return false;
    value = JSON.parse(fs.readFileSync(file, "utf8")) as T;
    return true;
  }, { timeout: 20_000, timeoutMsg: `native history gate did not publish ${context}` });
  return value!;
}

async function waitForAccepted(gate: ArmedGate): Promise<void> {
  expect(await waitForJson<GateAccepted>(gate.accepted, "admission")).toEqual({
    token: gate.token, entryId: gate.entryId, direction: gate.direction, pid: applicationPid,
  });
}

function forceRelease(gate: ArmedGate): void {
  if (fs.existsSync(gate.release)) return;
  const pending = `${gate.release}.tmp`;
  gateArtifacts.add(pending);
  fs.writeFileSync(pending, gate.token);
  fs.renameSync(pending, gate.release);
}

async function releaseGate(gate: ArmedGate): Promise<void> {
  forceRelease(gate);
  expect(await waitForJson<GateReleased>(gate.released, "release")).toEqual({
    token: gate.token, status: "released",
  });
}

async function destroyCurrentWindow(handle: string): Promise<void> {
  await browser.execute((detail) => window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail })), {
    token: crypto.randomUUID(), op: "native-destroy",
  });
  await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(handle), {
    timeout: 20_000, timeoutMsg: "native-destroy did not remove the child window",
  });
}

const gatedDescribe = process.platform === "linux" && gateDirectory ? describe : describe.skip;
gatedDescribe("native shared file-history lifetime (requires Linux and TAURI_E2E_HISTORY_GATE_DIR)", () => {
  before(async () => {
    fs.accessSync(gateDirectory, fs.constants.R_OK | fs.constants.W_OK);
    scratch = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-history-lifetime-"));
    await navigateTo(scratch);
    mainHandle = await browser.getWindowHandle();
    applicationPid = exactApplicationPid();
    await waitForHistoryReady();
    const opened = await freshWindow(scratch);
    expect(opened.kind).toBe("fresh");
    childHandle = await switchToLabel(opened.label);
    await $(".file-list").waitForExist({ timeout: 20_000 });
    await waitForHistoryReady();
    await clearBothHistories();
  });

  after(async () => {
    // Each case releases its gate in finally. Wait for real native settlement
    // before deleting fixtures; a failed assertion must not race the inverse.
    if (mainHandle && (await browser.getWindowHandles()).includes(mainHandle)) {
      await browser.switchToWindow(mainHandle);
      await waitForSummary((s) => !s.busy, "finish accepted work before fixture cleanup");
    }
    for (const artifact of gateArtifacts) {
      try { fs.rmSync(artifact, { force: true }); } catch { /* preserve test failure */ }
    }
    if (mainHandle) {
      for (const handle of await browser.getWindowHandles()) {
        if (handle === mainHandle) continue;
        await browser.switchToWindow(handle);
        await browser.closeWindow();
      }
      if ((await browser.getWindowHandles()).includes(mainHandle)) await browser.switchToWindow(mainHandle);
    }
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("admits a shared inverse once and synchronizes both participants", async function () {
    this.timeout(120_000);
    const bytes = `shared admission ${crypto.randomUUID()}\n`;
    const fixture = renameFixture("shared", bytes);
    let gate: ArmedGate | undefined;
    try {
      await browser.switchToWindow(mainHandle);
      const pushed = await historyOperation("push", { action: fixture.action, shared: true });
      expect(pushed.error).toBeUndefined();
      const entryId = pushed.summary.undoId;
      if (entryId === null) throw new Error("shared history push returned no undo ID");
      await browser.switchToWindow(childHandle);
      await waitForSummary((s) => s.undoId === entryId && s.stackSize === 1, "publish the shared ID to peer");

      await browser.switchToWindow(mainHandle);
      gate = armGate(entryId, "undo");
      const pendingUndo = await startHistoryOperation("execute", { direction: "undo", expectedEntryId: entryId });
      await waitForAccepted(gate);
      expectOnlyPath(fixture.renamed, fixture.original, bytes);
      await waitForSummary((s) => s.busy, "show native admission as busy");

      await browser.switchToWindow(childHandle);
      await waitForSummary((s) => s.busy, "publish busy state to peer");
      const duplicate = await historyOperation("execute", { direction: "undo", expectedEntryId: entryId });
      expect(duplicate.error).toMatch(/already in progress/i);
      expectOnlyPath(fixture.renamed, fixture.original, bytes);

      await releaseGate(gate);
      await browser.switchToWindow(mainHandle);
      expect(unwrap(await waitForHistoryResult(pendingUndo)).error).toBeUndefined();
      expectOnlyPath(fixture.original, fixture.renamed, bytes);
      const mainSettled = await waitForSummary(
        (s) => !s.busy && s.undoId === null && s.redoId !== null,
        "settle shared undo in main",
      );
      await browser.switchToWindow(childHandle);
      const childSettled = await waitForSummary(
        (s) => !s.busy && s.undoId === null && s.redoId !== null,
        "settle shared undo in peer",
      );
      expect(childSettled.redoId).toBe(mainSettled.redoId);

      const stale = await historyOperation("execute", { direction: "undo", expectedEntryId: entryId });
      expect(stale.error).toMatch(/history changed/i);
      expectOnlyPath(fixture.original, fixture.renamed, bytes);
      expect((await historyOperation("execute", {
        direction: "redo", expectedEntryId: childSettled.redoId!,
      })).error).toBeUndefined();
      expectOnlyPath(fixture.renamed, fixture.original, bytes);
      const childRedone = await waitForSummary(
        (s) => !s.busy && s.undoId !== null && s.redoId === null,
        "publish completed redo",
      );
      await browser.switchToWindow(mainHandle);
      await waitForSummary(
        (s) => !s.busy && s.undoId === childRedone.undoId && s.redoId === null,
        "mirror redo in main",
      );
    } finally {
      if (gate) forceRelease(gate);
    }
  });

  it("settles accepted shared work after the invoking child is destroyed", async function () {
    this.timeout(120_000);
    await clearBothHistories();
    const bytes = `destroyed renderer ${crypto.randomUUID()}\n`;
    const fixture = renameFixture("destroyed-child", bytes);
    let gate: ArmedGate | undefined;
    try {
      await browser.switchToWindow(childHandle);
      const pushed = await historyOperation("push", { action: fixture.action, shared: true });
      expect(pushed.error).toBeUndefined();
      const entryId = pushed.summary.undoId;
      if (entryId === null) throw new Error("child shared history push returned no undo ID");
      await browser.switchToWindow(mainHandle);
      await waitForSummary((s) => s.undoId === entryId && s.stackSize === 1, "publish child entry to main");

      await browser.switchToWindow(childHandle);
      gate = armGate(entryId, "undo");
      await startHistoryOperation("execute", { direction: "undo", expectedEntryId: entryId });
      await waitForAccepted(gate);
      expectOnlyPath(fixture.renamed, fixture.original, bytes);
      await browser.switchToWindow(mainHandle);
      await waitForSummary((s) => s.busy, "publish child admission to main");
      const duplicate = await historyOperation("execute", { direction: "undo", expectedEntryId: entryId });
      expect(duplicate.error).toMatch(/already in progress/i);
      expectOnlyPath(fixture.renamed, fixture.original, bytes);

      await browser.switchToWindow(childHandle);
      await destroyCurrentWindow(childHandle);
      childHandle = "";
      await browser.switchToWindow(mainHandle);
      await releaseGate(gate);
      const settled = await waitForSummary(
        (s) => !s.busy && s.undoId === null && s.redoId !== null,
        "settle destroyed child's accepted undo",
      );
      expectOnlyPath(fixture.original, fixture.renamed, bytes);
      expect((await historyOperation("execute", {
        direction: "redo", expectedEntryId: settled.redoId!,
      })).error).toBeUndefined();
      expectOnlyPath(fixture.renamed, fixture.original, bytes);
      await waitForSummary((s) => !s.busy && s.undoId !== null && s.redoId === null, "publish main redo");
      await browser.waitUntil(async () => (await entryNames()).includes(path.basename(fixture.renamed)), {
        timeout: 20_000, timeoutMsg: "surviving listing did not show the redone rename",
      });
      const proofDirectory = path.resolve("screenshots/refactor/repo-health-cleanup");
      fs.mkdirSync(proofDirectory, { recursive: true });
      await browser.saveScreenshot(path.join(proofDirectory, "native-file-history-lifetime.png"));
    } finally {
      if (gate) forceRelease(gate);
    }
  });
});
