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

async function historySummary(): Promise<{ undoId: number | null; redoId: number | null }> {
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
        assert.deepEqual(await historySummary(), before);
        assert.ok((await entryNames()).includes(path.basename(target)));

        fs.rmSync(target);
        const completed = await operation<SessionResult>(`complete-${operationName}`, { source, destination });
        assert.ok(completed.ok, completed.error);
        assert.deepEqual(completed.data?.items.map(item => item.status), ["succeeded"]);
        assert.equal(fs.readFileSync(target, "utf8"), incoming);
        await browser.waitUntil(async () => (await entryNames()).includes(path.basename(target)), {
          timeoutMsg: `${operationName} completion did not refresh the rendered listing`,
        });
        assert.notEqual((await historySummary()).undoId, before.undoId);

        await history("undo");
        assert.ok(!fs.existsSync(target));
        await browser.waitUntil(async () => !(await entryNames()).includes(path.basename(target)), {
          timeoutMsg: `${operationName} Undo did not refresh the rendered listing`,
        });
        await history("redo");
        assert.equal(fs.readFileSync(target, "utf8"), incoming);
        await browser.waitUntil(async () => (await entryNames()).includes(path.basename(target)), {
          timeoutMsg: `${operationName} Redo did not refresh the rendered listing`,
        });
      });
    }
  },
);
