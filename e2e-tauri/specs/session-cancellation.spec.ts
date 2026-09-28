import { browser } from "@wdio/globals";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createNativeFixtureDirectory } from "../native-qualification";
import { entryNames, navigateTo } from "./helpers";

const scratch = createNativeFixtureDirectory("session-cancellation-");

interface SessionResult {
  ok: boolean;
  data?: { cancelled: boolean; items: Array<{ status: string }> };
  error?: string;
}

async function operation<T>(op: string, args: Record<string, unknown>): Promise<T> {
  const token = crypto.randomUUID();
  await browser.waitUntil(async () => browser.execute(() =>
    document.documentElement.dataset.e2eRecoveryReady === "true"));
  await browser.execute((detail) => {
    window.dispatchEvent(new CustomEvent("e2e-recovery-operation", { detail }));
  }, { token, op, ...args });
  let response: { token?: string; result?: T; error?: string } = {};
  await browser.waitUntil(async () => {
    response = JSON.parse(await browser.execute(() =>
      document.documentElement.dataset.e2eRecoveryResult ?? "{}"));
    return response.token === token;
  }, { timeout: 20_000, timeoutMsg: `${op} did not settle` });
  if (response.error) throw new Error(response.error);
  return response.result as T;
}

interface HistorySummary {
  revision: number;
  undoId: number | null;
  redoId: number | null;
  stackSize: number;
  busy: boolean;
}

async function historySummary(): Promise<HistorySummary> {
  await browser.waitUntil(async () => browser.execute(() =>
    document.documentElement.dataset.e2eHistoryReady === "true"));
  return JSON.parse(await browser.execute(() =>
    document.documentElement.dataset.e2eHistorySummary ?? "{}"));
}

async function history(direction: "undo" | "redo"): Promise<void> {
  const token = crypto.randomUUID();
  await browser.execute((detail) => {
    window.dispatchEvent(new CustomEvent("e2e-file-op", { detail }));
  }, { token, op: direction });
  let result: { token?: string; error?: string | null } = {};
  await browser.waitUntil(async () => {
    result = JSON.parse(await browser.execute(() =>
      document.documentElement.dataset.e2eFileOperationResult ?? "{}"));
    return result.token === token;
  }, { timeoutMsg: `${direction} did not settle` });
  assert.equal(result.error, null);
}

(process.platform === "linux" || process.platform === "win32" ? describe : describe.skip)(
  "native session cancellation qualification",
  () => {
    for (const operationName of ["copy", "move"] as const) {
      it(`cancels ${operationName} through IPC, releases admission, and preserves listing/history outcomes`, async () => {
        const root = path.join(scratch, operationName);
        const sourceDirectory = path.join(root, "source");
        const destination = path.join(root, "destination");
        fs.mkdirSync(sourceDirectory, { recursive: true });
        fs.mkdirSync(destination, { recursive: true });
        const source = path.join(sourceDirectory, `${operationName}.txt`);
        const target = path.join(destination, `${operationName}.txt`);
        const incoming = `${operationName} cancellation payload\n`;
        const existing = `${operationName} existing destination\n`;
        const assertForwardSource = () => {
          if (operationName === "move") assert.equal(fs.existsSync(source), false);
          else assert.equal(fs.readFileSync(source, "utf8"), incoming);
        };
        fs.writeFileSync(source, incoming);
        fs.writeFileSync(target, existing);
        await navigateTo(destination);
        await browser.waitUntil(async () => (await entryNames()).includes(path.basename(target)));
        const before = await historySummary();

        const cancelled = await operation<SessionResult>(`cancel-${operationName}`, { source, destination });
        assert.ok(cancelled.ok, cancelled.error);
        assert.equal(cancelled.data?.cancelled, true);
        assert.deepEqual(cancelled.data?.items.map(item => item.status), ["unstarted"]);
        assert.equal(fs.readFileSync(source, "utf8"), incoming);
        assert.equal(fs.readFileSync(target, "utf8"), existing);
        const afterCancellation = await historySummary();
        assert.ok(afterCancellation.revision > before.revision, "history did not settle the cancelled reservation");
        assert.equal(afterCancellation.undoId, before.undoId);
        assert.equal(afterCancellation.redoId, before.redoId);
        assert.equal(afterCancellation.stackSize, before.stackSize);
        assert.equal(afterCancellation.busy, false);
        assert.ok((await entryNames()).includes(path.basename(target)));

        fs.rmSync(target);
        const completed = await operation<SessionResult>(`complete-${operationName}`, { source, destination });
        assert.ok(completed.ok, completed.error);
        assert.deepEqual(completed.data?.items.map(item => item.status), ["succeeded"]);
        assert.equal(fs.readFileSync(target, "utf8"), incoming);
        assertForwardSource();
        await browser.waitUntil(async () => (await entryNames()).includes(path.basename(target)), {
          timeoutMsg: `${operationName} completion did not refresh the rendered listing`,
        });
        assert.notEqual((await historySummary()).undoId, before.undoId);

        await history("undo");
        assert.ok(!fs.existsSync(target));
        assert.equal(fs.readFileSync(source, "utf8"), incoming);
        await browser.waitUntil(async () => !(await entryNames()).includes(path.basename(target)), {
          timeoutMsg: `${operationName} Undo did not refresh the rendered listing`,
        });
        await history("redo");
        assert.equal(fs.readFileSync(target, "utf8"), incoming);
        assertForwardSource();
        await browser.waitUntil(async () => (await entryNames()).includes(path.basename(target)), {
          timeoutMsg: `${operationName} Redo did not refresh the rendered listing`,
        });
      });

      it(`retains only the completed ${operationName} prefix when cancelling a later conflict`, async () => {
        const root = path.join(scratch, `${operationName}-prefix`);
        const sourceDirectory = path.join(root, "source");
        const destination = path.join(root, "destination");
        fs.mkdirSync(sourceDirectory, { recursive: true });
        fs.mkdirSync(destination, { recursive: true });
        const names = ["prefix.txt", "conflict.txt", "suffix.txt"];
        const sources = names.map(name => path.join(sourceDirectory, name));
        const targets = names.map(name => path.join(destination, name));
        for (const [index, source] of sources.entries()) {
          fs.writeFileSync(source, `${operationName} payload ${index}\n`);
        }
        fs.writeFileSync(targets[1], "existing destination\n");
        await navigateTo(destination);
        await browser.waitUntil(async () => (await entryNames()).includes(names[1]));
        const before = await historySummary();

        const cancelled = await operation<SessionResult>(`cancel-${operationName}`, { sources, destination });
        assert.ok(cancelled.ok, cancelled.error);
        assert.equal(cancelled.data?.cancelled, true);
        assert.deepEqual(cancelled.data?.items.map(item => item.status), ["succeeded", "unstarted", "unstarted"]);
        assert.equal(fs.readFileSync(targets[0], "utf8"), `${operationName} payload 0\n`);
        assert.equal(fs.readFileSync(targets[1], "utf8"), "existing destination\n");
        assert.equal(fs.existsSync(targets[2]), false);
        assert.equal(fs.existsSync(sources[0]), operationName === "copy");
        for (const index of [1, 2]) {
          assert.equal(fs.readFileSync(sources[index], "utf8"), `${operationName} payload ${index}\n`);
        }
        const afterCancellation = await historySummary();
        assert.notEqual(afterCancellation.undoId, before.undoId);
        assert.equal(afterCancellation.busy, false);
        await browser.waitUntil(async () => (await entryNames()).includes(names[0]));

        await history("undo");
        assert.equal(fs.existsSync(targets[0]), false);
        assert.equal(fs.readFileSync(sources[0], "utf8"), `${operationName} payload 0\n`);
        assert.equal(fs.readFileSync(targets[1], "utf8"), "existing destination\n");
        assert.equal(fs.existsSync(targets[2]), false);
        await browser.waitUntil(async () => !(await entryNames()).includes(names[0]));

        await history("redo");
        assert.equal(fs.readFileSync(targets[0], "utf8"), `${operationName} payload 0\n`);
        assert.equal(fs.existsSync(sources[0]), operationName === "copy");
        assert.equal(fs.readFileSync(targets[1], "utf8"), "existing destination\n");
        assert.equal(fs.existsSync(targets[2]), false);
        await browser.waitUntil(async () => (await entryNames()).includes(names[0]));
      });
    }
  },
);
