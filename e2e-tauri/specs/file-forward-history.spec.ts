/** Native forward mutations admit and settle history before renderer-side UI work. */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exactApplicationPid } from "../native-process";
import { entryNames, navigateTo } from "./helpers";

interface HistorySummary {
  revision: number;
  undoId: number | null;
  redoId: number | null;
  stackSize: number;
  busy: boolean;
}

interface HistoryEnvelope {
  token: string;
  result?: { summary: HistorySummary; error?: string };
  error?: string;
}

interface FileOperationResult {
  token: string;
  status: "completed";
  completedAt: number;
  error: string | null;
}

interface MutationProbe {
  token: string;
  command: "rename_entry";
  targetPath: string;
  status: "armed" | "held" | "released";
  resultPath?: string;
}

interface ForwardAccepted {
  token: string;
  entryId: number;
  direction: "forward";
  pid: number;
}

interface ForwardReleased {
  token: string;
  status: "released" | "timeout";
}

interface ForwardGate {
  token: string;
  directory: string;
  arm: string;
  accepted: string;
  entryId?: number;
  release?: string;
  released?: string;
}

const gateDirectory = process.env.TAURI_E2E_HISTORY_GATE_DIR ?? "";
const gateArtifacts = new Set<string>();
let scratch = "";
let mainHandle = "";
let childHandle = "";
let applicationPid = 0;
let armedMutationToken: string | null = null;

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

async function waitForSummary(
  predicate: (summary: HistorySummary) => boolean,
  context: string,
): Promise<HistorySummary> {
  let observed: HistorySummary | undefined;
  await browser.waitUntil(async () => {
    observed = await currentSummary();
    return predicate(observed);
  }, { timeout: 20_000, timeoutMsg: `history summary did not ${context}` });
  return observed!;
}

async function clearHistory(): Promise<void> {
  const token = `clear-${crypto.randomUUID()}`;
  await browser.execute((detail) => {
    delete document.documentElement.dataset.e2eHistoryResult;
    window.dispatchEvent(new CustomEvent("e2e-history-operation", { detail }));
  }, { token, op: "clear" });
  let envelope: HistoryEnvelope | undefined;
  await browser.waitUntil(async () => {
    const encoded = await browser.execute(() => document.documentElement.dataset.e2eHistoryResult);
    if (!encoded) return false;
    envelope = JSON.parse(encoded) as HistoryEnvelope;
    return envelope.token === token;
  }, { timeout: 20_000, timeoutMsg: "native history clear did not finish" });
  if (envelope!.error || !envelope!.result) {
    throw new Error(envelope!.error ?? "native history clear returned no result");
  }
  expect(envelope!.result.error).toBeUndefined();
  await waitForSummary(
    (summary) => summary.undoId === null && summary.redoId === null && !summary.busy,
    "clear",
  );
}

async function startFileOperation(
  token: string,
  detail: { op: "rename" | "undo" | "redo"; path?: string; name?: string },
): Promise<void> {
  await browser.execute((operation) => {
    delete document.documentElement.dataset.e2eFileOperationResult;
    window.dispatchEvent(new CustomEvent("e2e-file-op", { detail: operation }));
  }, { token, ...detail });
}

async function waitForFileOperation(token: string): Promise<FileOperationResult> {
  await browser.waitUntil(async () => await browser.execute((operationToken) => {
    const encoded = document.documentElement.dataset.e2eFileOperationResult;
    if (!encoded) return false;
    const result = JSON.parse(encoded) as FileOperationResult;
    return result.token === operationToken && result.status === "completed";
  }, token), {
    timeout: 25_000,
    timeoutMsg: `file operation ${token} did not finish`,
  });
  return await browser.execute(() =>
    JSON.parse(document.documentElement.dataset.e2eFileOperationResult!) as FileOperationResult);
}

async function fileOperation(
  detail: { op: "rename" | "undo" | "redo"; path?: string; name?: string },
): Promise<FileOperationResult> {
  const token = `${detail.op}-${crypto.randomUUID()}`;
  await startFileOperation(token, detail);
  return await waitForFileOperation(token);
}

async function mutationProbe(): Promise<MutationProbe | null> {
  return await browser.execute(() => {
    const encoded = document.documentElement.dataset.e2eFileMutationProbe;
    return encoded ? JSON.parse(encoded) as MutationProbe : null;
  });
}

async function armRenameResult(token: string, targetPath: string): Promise<void> {
  await browser.waitUntil(async () => await browser.execute(() =>
    document.documentElement.dataset.e2eFileMutationProbeReady === "true"), {
    timeout: 15_000,
    timeoutMsg: "file mutation probe never became ready",
  });
  armedMutationToken = token;
  await browser.execute((probeToken, pathToMatch) => {
    window.dispatchEvent(new CustomEvent("e2e-file-mutation-probe", {
      detail: { token: probeToken, command: "rename_entry", targetPath: pathToMatch },
    }));
  }, token, targetPath);
  await browser.waitUntil(async () => {
    const probe = await mutationProbe();
    return probe?.token === token && probe.status === "armed";
  }, { timeout: 5_000, timeoutMsg: "rename result probe was not armed" });
}

async function releaseMutation(token: string): Promise<void> {
  await browser.execute((probeToken) => {
    window.dispatchEvent(new CustomEvent("e2e-file-mutation-release", {
      detail: { token: probeToken },
    }));
  }, token);
  if (armedMutationToken === token) armedMutationToken = null;
}

function expectOnlyPath(expected: string, absent: string, contents: string): void {
  expect(fs.existsSync(expected)).toBe(true);
  expect(fs.readFileSync(expected, "utf8")).toBe(contents);
  expect(fs.existsSync(absent)).toBe(false);
  expect([expected, absent].filter((candidate) => fs.existsSync(candidate))).toHaveLength(1);
}

async function waitForListed(name: string, present: boolean): Promise<void> {
  await browser.waitUntil(async () => (await entryNames()).includes(name) === present, {
    timeout: 20_000,
    timeoutMsg: `${name} remained ${present ? "absent from" : "present in"} the surviving listing`,
  });
}

function armForwardGate(directory: string): ForwardGate {
  const token = crypto.randomUUID();
  const gate: ForwardGate = {
    token,
    directory,
    arm: path.join(gateDirectory, "next-forward.arm"),
    accepted: path.join(gateDirectory, "next-forward.accepted.json"),
  };
  const pending = path.join(gateDirectory, `next-forward.${token}.pending`);
  for (const artifact of [gate.arm, gate.accepted, pending]) {
    gateArtifacts.add(artifact);
    if (fs.existsSync(artifact)) throw new Error(`forward gate artifact already exists: ${artifact}`);
  }
  fs.writeFileSync(pending, JSON.stringify({ token, directory }));
  fs.renameSync(pending, gate.arm);
  return gate;
}

async function waitForJson<T>(file: string, context: string): Promise<T> {
  let value: T | undefined;
  await browser.waitUntil(() => {
    if (!fs.existsSync(file)) return false;
    value = JSON.parse(fs.readFileSync(file, "utf8")) as T;
    return true;
  }, { timeout: 20_000, timeoutMsg: `native forward gate did not publish ${context}` });
  return value!;
}

async function waitForForwardAccepted(gate: ForwardGate): Promise<ForwardAccepted> {
  const accepted = await waitForJson<ForwardAccepted>(gate.accepted, "admission");
  expect(accepted.token).toBe(gate.token);
  expect(Number.isSafeInteger(accepted.entryId) && accepted.entryId > 0).toBe(true);
  expect(accepted.direction).toBe("forward");
  expect(accepted.pid).toBe(applicationPid);
  gate.entryId = accepted.entryId;
  gate.release = path.join(gateDirectory, `${accepted.entryId}-forward.${gate.token}.release`);
  gate.released = path.join(gateDirectory, `${accepted.entryId}-forward.released.json`);
  for (const artifact of [gate.release, gate.released]) {
    gateArtifacts.add(artifact);
    if (fs.existsSync(artifact)) throw new Error(`forward gate artifact already exists: ${artifact}`);
  }
  return accepted;
}

function forceReleaseForward(gate: ForwardGate): void {
  if (!gate.release && fs.existsSync(gate.accepted)) {
    const accepted = JSON.parse(fs.readFileSync(gate.accepted, "utf8")) as ForwardAccepted;
    if (accepted.token === gate.token && accepted.direction === "forward") {
      gate.entryId = accepted.entryId;
      gate.release = path.join(gateDirectory, `${accepted.entryId}-forward.${gate.token}.release`);
      gate.released = path.join(gateDirectory, `${accepted.entryId}-forward.released.json`);
      gateArtifacts.add(gate.release);
      gateArtifacts.add(gate.released);
    }
  }
  if (!gate.release || fs.existsSync(gate.release)) return;
  const pending = `${gate.release}.pending`;
  gateArtifacts.add(pending);
  fs.writeFileSync(pending, gate.token);
  fs.renameSync(pending, gate.release);
}

async function releaseForward(gate: ForwardGate): Promise<void> {
  if (!gate.released) throw new Error("forward gate was not accepted");
  forceReleaseForward(gate);
  expect(await waitForJson<ForwardReleased>(gate.released, "release")).toEqual({
    token: gate.token,
    status: "released",
  });
}

async function freshWindow(target: string): Promise<{ kind: string; label: string }> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => {
    delete document.documentElement.dataset.e2eWindowResult;
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail }));
  }, { token, op: "fresh-open", target });
  let envelope: { token?: string; result?: { kind: string; label: string }; error?: string } = {};
  await browser.waitUntil(async () => {
    envelope = await browser.execute(() =>
      JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
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

async function destroyCurrentWindow(handle: string): Promise<void> {
  await browser.execute((detail) => {
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail }));
  }, { token: crypto.randomUUID(), op: "native-destroy" });
  await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(handle), {
    timeout: 20_000,
    timeoutMsg: "native-destroy did not remove the child window",
  });
}

const gatedDescribe = process.platform === "linux" && gateDirectory ? describe : describe.skip;

gatedDescribe("native forward mutation history ownership", () => {
  before(async () => {
    fs.accessSync(gateDirectory, fs.constants.R_OK | fs.constants.W_OK);
    scratch = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-forward-history-"));
    await navigateTo(scratch);
    mainHandle = await browser.getWindowHandle();
    applicationPid = exactApplicationPid();
    await waitForHistoryReady();
  });

  afterEach(async () => {
    if (armedMutationToken && (await browser.getWindowHandles()).includes(mainHandle)) {
      await browser.switchToWindow(mainHandle);
      await releaseMutation(armedMutationToken);
    }
  });

  after(async () => {
    for (const artifact of gateArtifacts) {
      try { fs.rmSync(artifact, { force: true }); } catch { /* preserve the primary failure */ }
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

  it("exposes one native Undo while renderer publication of the rename is held", async function () {
    this.timeout(90_000);
    await browser.switchToWindow(mainHandle);
    await clearHistory();
    const suffix = crypto.randomUUID().slice(0, 8);
    const original = path.join(scratch, `held-${suffix}.txt`);
    const renamed = path.join(scratch, `held-${suffix}-renamed.txt`);
    const contents = `native forward admission ${suffix}\n`;
    fs.writeFileSync(original, contents);
    await navigateTo(scratch);
    await waitForListed(path.basename(original), true);

    const token = `rename-held-${crypto.randomUUID()}`;
    await armRenameResult(token, original);
    await startFileOperation(token, { op: "rename", path: original, name: path.basename(renamed) });

    await browser.waitUntil(() => fs.existsSync(renamed), {
      timeout: 20_000,
      timeoutMsg: "native rename did not commit while its renderer result was held",
    });
    await browser.waitUntil(async () => {
      const probe = await mutationProbe();
      return probe?.token === token && probe.status === "held" && probe.resultPath === renamed;
    }, { timeout: 20_000, timeoutMsg: "successful native rename result was not held" });
    const held = await mutationProbe();
    expectOnlyPath(renamed, original, contents);
    expect(await browser.execute((operationToken) => {
      const encoded = document.documentElement.dataset.e2eFileOperationResult;
      return encoded ? (JSON.parse(encoded) as FileOperationResult).token === operationToken : false;
    }, token)).toBe(false);

    const admitted = await waitForSummary(
      (summary) => summary.undoId !== null && summary.stackSize === 1 && !summary.busy,
      "admit exactly one forward rename before renderer completion",
    );
    await releaseMutation(token);
    expect((await waitForFileOperation(token)).error).toBeNull();
    const afterRenderer = await currentSummary();
    expect(afterRenderer.undoId).toBe(admitted.undoId);
    expect(afterRenderer.stackSize).toBe(1);

    expect((await fileOperation({ op: "undo" })).error).toBeNull();
    expectOnlyPath(original, renamed, contents);
    const afterUndo = await waitForSummary(
      (summary) => summary.undoId === null && summary.redoId !== null && summary.stackSize === 0 && !summary.busy,
      "consume the sole native rename entry",
    );
    console.log(JSON.stringify({
      case: "native-forward-held-result",
      held,
      admitted,
      afterRenderer,
      afterUndo,
    }));
  });

  it("preserves an existing Redo after an exact same-name rename", async function () {
    this.timeout(90_000);
    await browser.switchToWindow(mainHandle);
    await clearHistory();
    const suffix = crypto.randomUUID().slice(0, 8);
    const original = path.join(scratch, `same-${suffix}.txt`);
    const renamed = path.join(scratch, `same-${suffix}-renamed.txt`);
    const contents = `same-name no-op ${suffix}\n`;
    fs.writeFileSync(original, contents);
    await navigateTo(scratch);
    await waitForListed(path.basename(original), true);

    expect((await fileOperation({
      op: "rename", path: original, name: path.basename(renamed),
    })).error).toBeNull();
    expectOnlyPath(renamed, original, contents);
    expect((await fileOperation({ op: "undo" })).error).toBeNull();
    expectOnlyPath(original, renamed, contents);
    const seeded = await waitForSummary(
      (summary) => summary.undoId === null && summary.redoId !== null && !summary.busy,
      "seed Redo from an actual native rename",
    );

    expect((await fileOperation({
      op: "rename", path: original, name: path.basename(original),
    })).error).toBeNull();
    expectOnlyPath(original, renamed, contents);
    const afterNoOp = await currentSummary();
    expect(afterNoOp.redoId).toBe(seeded.redoId);
    expect(afterNoOp.undoId).toBeNull();
    expect(afterNoOp.stackSize).toBe(0);
    console.log(JSON.stringify({
      case: "native-forward-same-name",
      seeded,
      afterNoOp,
    }));

    expect((await fileOperation({ op: "redo" })).error).toBeNull();
    expectOnlyPath(renamed, original, contents);
  });

  it("completes an accepted child rename after that renderer is destroyed", async function () {
    this.timeout(120_000);
    await browser.switchToWindow(mainHandle);
    await clearHistory();
    const suffix = crypto.randomUUID().slice(0, 8);
    const original = path.join(scratch, `child-${suffix}.txt`);
    const renamed = path.join(scratch, `child-${suffix}-renamed.txt`);
    const contents = `destroyed forward owner ${suffix}\n`;
    fs.writeFileSync(original, contents);
    await navigateTo(scratch);
    await waitForListed(path.basename(original), true);

    const opened = await freshWindow(scratch);
    expect(opened.kind).toBe("fresh");
    childHandle = await switchToLabel(opened.label);
    await $(".file-list").waitForExist({ timeout: 20_000 });
    await waitForHistoryReady();
    await waitForListed(path.basename(original), true);
    await clearHistory();

    const gate = armForwardGate(scratch);
    try {
      await startFileOperation(`child-rename-${suffix}`, {
        op: "rename", path: original, name: path.basename(renamed),
      });
      const accepted = await waitForForwardAccepted(gate);
      expectOnlyPath(original, renamed, contents);
      await waitForSummary(
        (summary) => summary.busy && summary.undoId === null,
        "show the child forward reservation as pending",
      );

      await destroyCurrentWindow(childHandle);
      childHandle = "";
      await browser.switchToWindow(mainHandle);
      const survivorBeforeRelease = await currentSummary();
      expect(survivorBeforeRelease.undoId).toBeNull();
      expect(survivorBeforeRelease.redoId).toBeNull();
      expect(survivorBeforeRelease.busy).toBe(false);

      await releaseForward(gate);
      await browser.waitUntil(() => fs.existsSync(renamed) && !fs.existsSync(original), {
        timeout: 20_000,
        timeoutMsg: "accepted child rename did not commit after renderer destruction",
      });
      expectOnlyPath(renamed, original, contents);
      await waitForListed(path.basename(renamed), true);
      await waitForListed(path.basename(original), false);
      const survivor = await currentSummary();
      expect(survivor.undoId).toBeNull();
      expect(survivor.redoId).toBeNull();
      expect(survivor.busy).toBe(false);
      const proofDirectory = path.resolve("screenshots/refactor/repo-health-cleanup");
      fs.mkdirSync(proofDirectory, { recursive: true });
      await browser.saveScreenshot(path.join(proofDirectory, "native-forward-history.png"));
      console.log(JSON.stringify({
        case: "native-forward-renderer-destroy",
        accepted,
        original,
        renamed,
        survivorEntries: await entryNames(),
        survivorHistory: survivor,
      }));
    } finally {
      forceReleaseForward(gate);
      if (gate.released) {
        try {
          await waitForJson<ForwardReleased>(gate.released, "failure-path release");
          await browser.waitUntil(() => fs.existsSync(renamed) || !fs.existsSync(original), {
            timeout: 20_000,
            timeoutMsg: "released child forward operation did not reach an observable outcome",
          });
        } catch { /* preserve the primary assertion failure */ }
      }
    }
  });
});
