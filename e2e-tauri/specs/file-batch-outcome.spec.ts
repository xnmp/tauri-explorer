/** Partial native batch outcomes must drive undo history from actual successes. */
import { browser, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryNames, navigateTo } from "./helpers";

// Keep trash and restore on the home filesystem. Linux cannot always trash
// `/tmp` entries when it is a separate tmpfs without its own Trash directory.
const scratch = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-file-outcome-"));
const suffix = crypto.randomUUID().slice(0, 8);
const fileAName = `outcome-a-${suffix}.txt`;
const fileBName = `outcome-b-${suffix}.txt`;
const fileAPath = path.join(scratch, fileAName);
const fileBPath = path.join(scratch, fileBName);
const fileAContents = `restorable A ${suffix}\n`;
const fileBContents = `externally removed B ${suffix}\n`;

interface FileOperationResult {
  token: string;
  status: "captured" | "completed";
  completedAt: number;
  error: string | null;
}

const operationResults: FileOperationResult[] = [];

async function dispatchOperation(
  detail: { op: string; token: string; paths?: string[] },
  expectedStatus: FileOperationResult["status"],
): Promise<FileOperationResult> {
  await browser.execute((operation) => {
    delete document.documentElement.dataset.e2eFileOperationResult;
    window.dispatchEvent(new CustomEvent("e2e-file-op", { detail: operation }));
  }, detail);

  await browser.waitUntil(async () => await browser.execute(
    (operationToken: string, status: string) => {
      const encoded = document.documentElement.dataset.e2eFileOperationResult;
      if (!encoded) return false;
      const result = JSON.parse(encoded) as FileOperationResult;
      return result.token === operationToken && result.status === status;
    },
    detail.token,
    expectedStatus,
  ), {
    timeout: 20_000,
    timeoutMsg: `${detail.op} did not acknowledge ${expectedStatus}`,
  });

  // Transport application failures as text. WebDriver can interpret an object
  // with an own `error` field as a protocol failure before the test receives it.
  const encoded = await browser.execute(() => document.documentElement.dataset.e2eFileOperationResult!);
  const result = JSON.parse(encoded) as FileOperationResult;
  operationResults.push(result);
  return result;
}

async function waitForListed(name: string, present: boolean): Promise<void> {
  await browser.waitUntil(async () => (await entryNames()).includes(name) === present, {
    timeout: 20_000,
    timeoutMsg: `${name} remained ${present ? "absent from" : "present in"} the file list`,
  });
}

async function waitForDisk(filePath: string, present: boolean): Promise<void> {
  await browser.waitUntil(() => fs.existsSync(filePath) === present, {
    timeout: 20_000,
    timeoutMsg: `${filePath} remained ${present ? "absent from" : "present on"} disk`,
  });
}

async function historyOperation(op: "undo" | "redo"): Promise<FileOperationResult> {
  return await dispatchOperation(
    { op, token: `${op}-${crypto.randomUUID()}` },
    "completed",
  );
}

describe("native partial file-operation outcomes", () => {
  before(() => {
    fs.writeFileSync(fileAPath, fileAContents);
    fs.writeFileSync(fileBPath, fileBContents);
  });

  afterEach(async () => {
    // Keep the original parent alive and ask the application to restore its own
    // trash entry before fixture cleanup, including after an assertion failure.
    if (!fs.existsSync(fileAPath)) {
      try {
        const recovery = await historyOperation("undo");
        if (recovery.error === null) await waitForDisk(fileAPath, true);
      } catch (error) {
        console.error(JSON.stringify({
          case: "file-batch-outcome-cleanup-failure",
          error: String(error),
          fileAPath,
          fileAExists: fs.existsSync(fileAPath),
        }));
      }
    }
  });

  after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("undoes and redoes only the item deleted by a partially failed batch", async function () {
    this.timeout(120_000);
    await navigateTo(scratch);
    await waitForListed(fileAName, true);
    await waitForListed(fileBName, true);

    try {
      const captureToken = `capture-${crypto.randomUUID()}`;
      const captured = await dispatchOperation({
        op: "capture-delete",
        paths: [fileAPath, fileBPath],
        token: captureToken,
      }, "captured");
      expect(captured.error).toBeNull();

      // Make the captured B snapshot stale outside the application. The real
      // delete command must report A as completed and B as failed.
      fs.unlinkSync(fileBPath);
      const deletion = await dispatchOperation({
        op: "confirm-captured-delete",
        token: captureToken,
      }, "completed");
      expect(deletion.error).not.toBeNull();
      expect(deletion.error).toContain(fileBName);
      await waitForDisk(fileAPath, false);
      await waitForListed(fileAName, false);
      expect(fs.existsSync(fileBPath)).toBe(false);
      await waitForListed(fileBName, false);

      const firstUndo = await historyOperation("undo");
      expect(firstUndo.error).toBeNull();
      await waitForDisk(fileAPath, true);
      await waitForListed(fileAName, true);
      expect(fs.readFileSync(fileAPath, "utf8")).toBe(fileAContents);
      expect(fs.existsSync(fileBPath)).toBe(false);
      expect(await entryNames()).not.toContain(fileBName);

      const redo = await historyOperation("redo");
      expect(redo.error).toBeNull();
      await waitForDisk(fileAPath, false);
      await waitForListed(fileAName, false);
      expect(fs.existsSync(fileBPath)).toBe(false);

      const secondUndo = await historyOperation("undo");
      expect(secondUndo.error).toBeNull();
      await waitForDisk(fileAPath, true);
      await waitForListed(fileAName, true);
      expect(fs.readFileSync(fileAPath, "utf8")).toBe(fileAContents);
      expect(fs.existsSync(fileBPath)).toBe(false);
      expect(await entryNames()).not.toContain(fileBName);
    } catch (error) {
      console.error(JSON.stringify({
        case: "file-batch-outcome-failure",
        error: String(error),
        fileAPath,
        fileBPath,
        fileAExists: fs.existsSync(fileAPath),
        fileBExists: fs.existsSync(fileBPath),
        fileAContents: fs.existsSync(fileAPath) ? fs.readFileSync(fileAPath, "utf8") : null,
        currentEntries: await entryNames(),
        operationResults,
      }));
      throw error;
    }
  });

  it("restores a deleted file through missing parents and refreshes the visible ancestor", async function () {
    if (process.platform !== "linux") this.skip();
    this.timeout(120_000);
    const outerName = `recreated-parent-${suffix}`;
    const outer = path.join(scratch, outerName);
    const parent = path.join(outer, "nested");
    const leaf = path.join(parent, "restored.txt");
    const contents = `restore through missing parents ${suffix}\n`;
    const proof = path.resolve("screenshots/refactor/repo-health-cleanup");
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(leaf, contents);
    try {
      await navigateTo(parent);
      await waitForListed("restored.txt", true);
      const token = `capture-${crypto.randomUUID()}`;
      expect((await dispatchOperation({ op: "capture-delete", paths: [leaf], token }, "captured")).error).toBeNull();
      expect((await dispatchOperation({ op: "confirm-captured-delete", token }, "completed")).error).toBeNull();
      await waitForDisk(leaf, false);
      await navigateTo(scratch);
      fs.rmdirSync(parent);
      fs.rmdirSync(outer);
      await waitForListed(outerName, false);
      fs.mkdirSync(proof, { recursive: true });
      await browser.saveScreenshot(path.join(proof, "native-restore-parents-before.png"));

      expect((await historyOperation("undo")).error).toBeNull();
      await waitForDisk(leaf, true);
      expect(fs.readFileSync(leaf, "utf8")).toBe(contents);
      await waitForListed(outerName, true);
      await browser.saveScreenshot(path.join(proof, "native-restore-parents-after.png"));
      await navigateTo(parent);
      await waitForListed("restored.txt", true);

      expect((await historyOperation("redo")).error).toBeNull();
      await waitForDisk(leaf, false);
      await waitForListed("restored.txt", false);
      expect(fs.statSync(parent).isDirectory()).toBe(true);
      expect((await historyOperation("undo")).error).toBeNull();
      await waitForListed("restored.txt", true);
      expect(fs.readFileSync(leaf, "utf8")).toBe(contents);
    } finally {
      if (!fs.existsSync(leaf)) await historyOperation("undo").catch(() => undefined);
      await navigateTo(scratch);
    }
  });
});
