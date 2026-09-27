/**
 * A move between two mounted filesystems, then Undo through the production
 * history authority (#774). The other Undo/Redo cycles run inside one
 * temporary directory, where a move is a rename; here every direction must
 * copy across devices and remove the other side.
 *
 * The contract depends on the build's move policy, which the job declares:
 * - Default build: an ordinary path inverse, so Undo and Redo cycle.
 * - `durable-move-recovery` (TAURI_E2E_DURABLE_MOVE_RECOVERY=1): the move is
 *   journaled and its record is the inverse. Undo consumes the record, so no
 *   Redo is offered (ADR 0020, lesson 685).
 *
 * Linux-only: /dev/shm and $HOME are the two mounts.
 */
import { browser } from "@wdio/globals";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileRecoverySnapshot } from "../../src/lib/domain/file-recovery";
import { gatedDescribe } from "./gated-describe";
import { entryNames, navigateTo } from "./helpers";

const durable = process.env.TAURI_E2E_DURABLE_MOVE_RECOVERY === "1";

interface HistorySummary {
  undoId: number | null;
  redoId: number | null;
  busy: boolean;
}

async function acknowledged<T>(
  event: "e2e-history-operation" | "e2e-recovery-operation",
  resultKey: "e2eHistoryResult" | "e2eRecoveryResult",
  detail: Record<string, unknown>,
): Promise<T> {
  const token = crypto.randomUUID();
  await browser.execute((name: string, key: string, payload: Record<string, unknown>) => {
    delete document.documentElement.dataset[key];
    window.dispatchEvent(new CustomEvent(name, { detail: payload }));
  }, event, resultKey, { ...detail, token });
  let response: { token?: string; result?: T; error?: string } = {};
  await browser.waitUntil(async () => {
    const encoded = await browser.execute((key: string) => document.documentElement.dataset[key], resultKey);
    if (!encoded) return false;
    response = JSON.parse(encoded);
    return response.token === token;
  }, { timeout: 30_000, timeoutMsg: `${String(detail.op)} did not acknowledge ${token}` });
  assert.ok(!response.error, response.error);
  return response.result as T;
}

async function summary(): Promise<HistorySummary> {
  const encoded = await browser.execute(() => document.documentElement.dataset.e2eHistorySummary);
  assert.ok(encoded, "the window publishes no history summary");
  return JSON.parse(encoded) as HistorySummary;
}

async function waitForSummary(predicate: (value: HistorySummary) => boolean, context: string): Promise<HistorySummary> {
  let observed: HistorySummary | undefined;
  await browser.waitUntil(async () => predicate(observed = await summary()), {
    timeout: 30_000,
    timeoutMsg: `history did not ${context}`,
  }).catch((error: unknown) => {
    throw new Error(`${(error as Error).message}; last summary ${JSON.stringify(observed)}`);
  });
  return observed!;
}

async function execute(direction: "undo" | "redo", expectedEntryId: number): Promise<void> {
  const result = await acknowledged<{ error?: string }>(
    "e2e-history-operation", "e2eHistoryResult", { op: "execute", direction, expectedEntryId },
  );
  assert.equal(result.error, undefined, `${direction} failed: ${result.error}`);
}

/** The file or tree at `root`, as relative path → contents. */
function snapshot(root: string): Record<string, string> {
  if (fs.lstatSync(root).isFile()) return { ".": fs.readFileSync(root, "utf8") };
  const entries: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, child.name);
      if (child.isDirectory()) walk(full);
      else entries[path.relative(root, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return entries;
}

function expectOnlyAt(present: string, absent: string, expected: Record<string, string>, context: string): void {
  assert.ok(!fs.existsSync(absent), `${context}: ${absent} still exists`);
  assert.deepEqual(snapshot(present), expected, `${context}: ${present} does not hold the moved entry`);
}

/** Only this test's own fixture roots; a durable build may leave a read-only
 *  private recovery root behind in either one. */
function removeFixture(root: string): void {
  if (!fs.existsSync(root)) return;
  const writable = (directory: string) => {
    fs.chmodSync(directory, 0o700);
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      if (child.isDirectory() && !child.isSymbolicLink()) writable(path.join(directory, child.name));
    }
  };
  writable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

gatedDescribe("native cross-device move history", [
  [process.platform === "linux", "Linux"],
  [fs.existsSync("/dev/shm"), "/dev/shm"],
], () => {
  before(async () => {
    await browser.waitUntil(async () => browser.execute(() =>
      document.documentElement.dataset.e2eHistoryReady === "true"
      && document.documentElement.dataset.e2eRecoveryReady === "true"), {
      timeout: 30_000,
      timeoutMsg: "history and recovery probes never became ready",
    });
  });

  for (const kind of ["file", "directory"] as const) {
    it(`moves a ${kind} across filesystems and undoes it through native history`, async function () {
      this.timeout(120_000);
      await acknowledged("e2e-history-operation", "e2eHistoryResult", { op: "clear" });
      await waitForSummary((s) => !s.busy && s.undoId === null && s.redoId === null, "clear");

      const sourceDirectory = fs.mkdtempSync(`/dev/shm/tauri-explorer-history-${kind}-`);
      const destination = fs.mkdtempSync(path.join(os.homedir(), `.tauri-explorer-history-${kind}-`));
      try {
        assert.notEqual(
          fs.statSync(sourceDirectory).dev, fs.statSync(destination).dev,
          "the fixture must span two filesystems",
        );
        const name = kind === "file" ? "moved.txt" : "moved-tree";
        const source = path.join(sourceDirectory, name);
        const target = path.join(destination, name);
        const marker = crypto.randomUUID();
        if (kind === "file") {
          fs.writeFileSync(source, `cross-device ${marker}\n`);
        } else {
          fs.mkdirSync(path.join(source, "nested"), { recursive: true });
          fs.writeFileSync(path.join(source, "top.txt"), `top ${marker}\n`);
          fs.writeFileSync(path.join(source, "nested", "leaf.txt"), `leaf ${marker}\n`);
        }
        const expected = snapshot(source);

        await navigateTo(destination);
        const moved = await acknowledged<{ ok: boolean; error?: string }>(
          "e2e-recovery-operation", "e2eRecoveryResult", { op: "move", source, destination },
        );
        assert.ok(moved.ok, moved.error);
        expectOnlyAt(target, source, expected, "forward move");
        await browser.waitUntil(async () => (await entryNames()).includes(name), {
          timeoutMsg: "the moved entry never appeared in the destination listing",
        });
        if (durable && kind === "file") {
          const evidence = path.join(process.cwd(), "screenshots/test/native-recovery-suites");
          fs.mkdirSync(evidence, { recursive: true });
          await browser.saveScreenshot(path.join(evidence, "cross-device-move-durable.png"));
        }
        const inventory = await acknowledged<FileRecoverySnapshot>(
          "e2e-recovery-operation", "e2eRecoveryResult", { op: "list" },
        );
        assert.equal(
          inventory.items.some((item) => item.originalPath === source), durable,
          durable
            ? "the durable build must journal the cross-device move"
            : "the default build must not journal an ordinary move",
        );
        let state = await waitForSummary((s) => !s.busy && s.undoId !== null, "publish the move's Undo");

        for (let cycle = 0; cycle < (durable ? 1 : 2); cycle++) {
          await execute("undo", state.undoId!);
          state = await waitForSummary(
            (s) => !s.busy && s.undoId === null && (durable ? s.redoId === null : s.redoId !== null),
            durable ? "settle Undo without offering Redo" : "settle Undo",
          );
          expectOnlyAt(source, target, expected, `Undo ${cycle + 1}`);
          await browser.waitUntil(async () => !(await entryNames()).includes(name), {
            timeoutMsg: "the undone entry stayed in the destination listing",
          });
          if (durable) break;

          await execute("redo", state.redoId!);
          state = await waitForSummary((s) => !s.busy && s.undoId !== null && s.redoId === null, "settle Redo");
          expectOnlyAt(target, source, expected, `Redo ${cycle + 1}`);
          await browser.waitUntil(async () => (await entryNames()).includes(name), {
            timeoutMsg: "the redone entry never returned to the destination listing",
          });
        }
      } finally {
        removeFixture(sourceDirectory);
        removeFixture(destination);
      }
    });
  }
});
