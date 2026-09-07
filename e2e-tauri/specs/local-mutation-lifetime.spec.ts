/** Native file-operation results retain their origin across pane navigation. */
import { browser, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryNames, navigateTo } from "./helpers";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-mutation-lifetime-"));
const originDirectory = path.join(scratch, "origin");
const destinationDirectory = path.join(scratch, "destination");

interface MutationProbe {
  token: string;
  command: "create_directory" | "rename_entry";
  targetPath: string;
  status: "armed" | "held" | "released";
  resultPath?: string;
  heldAt?: number;
}

interface FileOperationResult {
  token: string;
  status: "completed";
  completedAt: number;
  error?: string | null;
}

interface WatcherReceipt {
  count: number;
  observedAt: number | null;
}

let armedToken: string | null = null;

async function mutationProbe(): Promise<MutationProbe | null> {
  return await browser.execute(() => {
    const encoded = document.documentElement.dataset.e2eFileMutationProbe;
    return encoded ? JSON.parse(encoded) : null;
  });
}

async function waitForMutationProbeReady(): Promise<void> {
  await browser.waitUntil(
    async () => await browser.execute(
      () => document.documentElement.dataset.e2eFileMutationProbeReady === "true",
    ),
    { timeout: 15_000, timeoutMsg: "file mutation probe never became ready" },
  );
}

async function armCreateProbe(token: string, targetPath: string): Promise<void> {
  await waitForMutationProbeReady();
  armedToken = token;
  await browser.execute((probeToken: string, pathToMatch: string) => {
    window.dispatchEvent(new CustomEvent("e2e-file-mutation-probe", {
      detail: { token: probeToken, command: "create_directory", targetPath: pathToMatch },
    }));
  }, token, targetPath);
  await browser.waitUntil(async () => {
    const probe = await mutationProbe();
    return probe?.token === token && probe.status === "armed";
  }, { timeout: 5_000, timeoutMsg: "file mutation probe was not armed" });
}

async function releaseMutation(token: string): Promise<void> {
  await browser.execute((probeToken: string) => {
    window.dispatchEvent(new CustomEvent("e2e-file-mutation-release", {
      detail: { token: probeToken },
    }));
  }, token);
  if (armedToken === token) armedToken = null;
}

async function beginCreate(name: string, token: string): Promise<void> {
  await browser.execute((folderName: string, operationToken: string) => {
    delete document.documentElement.dataset.e2eFileOperationResult;
    window.dispatchEvent(new CustomEvent("e2e-file-op", {
      detail: { op: "new-folder", name: folderName, token: operationToken },
    }));
  }, name, token);
}

async function fileOperationResult(token: string): Promise<FileOperationResult> {
  await browser.waitUntil(async () => await browser.execute((operationToken: string) => {
    const encoded = document.documentElement.dataset.e2eFileOperationResult;
    if (!encoded) return false;
    const result = JSON.parse(encoded) as FileOperationResult;
    return result.token === operationToken && result.status === "completed";
  }, token), {
    interval: 25,
    timeout: 10_000,
    timeoutMsg: "file operation did not acknowledge completion after release",
  });
  return await browser.execute(() =>
    JSON.parse(document.documentElement.dataset.e2eFileOperationResult!) as FileOperationResult,
  );
}

async function waitForWatcherReady(targetPath: string): Promise<void> {
  await browser.waitUntil(async () => await browser.execute((pathToFind: string) => {
    const readyPaths: string[] = JSON.parse(
      document.documentElement.dataset.e2eReadyDirectoryWatches ?? "[]",
    );
    return document.documentElement.dataset.e2eDirectoryWatcherListenerReady === "true"
      && readyPaths.includes(pathToFind);
  }, targetPath), {
    timeout: 15_000,
    timeoutMsg: `pane watch was not acknowledged for ${targetPath}`,
  });
}

async function watcherReceipt(targetPath: string): Promise<WatcherReceipt> {
  return await browser.execute((pathToRead: string) => {
    const encoded = document.documentElement.dataset.e2eDirectoryWatcherReceipts;
    const receipts: Record<string, WatcherReceipt> = encoded ? JSON.parse(encoded) : {};
    return receipts[pathToRead] ?? { count: 0, observedAt: null };
  }, targetPath);
}

async function waitForCausalReceipt(
  targetPath: string,
  previousCount: number,
  notBefore: number,
): Promise<void> {
  await browser.waitUntil(async () => {
    const receipt = await watcherReceipt(targetPath);
    return receipt.count > previousCount
      && receipt.observedAt !== null
      && receipt.observedAt >= notBefore;
  }, {
    timeout: 15_000,
    timeoutMsg: "external destination write had no causal watcher receipt",
  });
}

async function selectedPaths(): Promise<string[]> {
  return await browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>(".file-list .entry-item.selected")]
      .map((entry) => entry.dataset.path)
      .filter((entryPath): entryPath is string => entryPath !== undefined),
  );
}

describe("local mutation navigation lifetime", () => {
  before(() => {
    fs.mkdirSync(originDirectory);
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(originDirectory, "a-seed.txt"), "origin\n");
    fs.writeFileSync(path.join(destinationDirectory, "b-seed.txt"), "destination\n");
  });

  afterEach(async () => {
    if (armedToken) await releaseMutation(armedToken);
  });

  after(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps a completed create with A while B admits a later external write", async () => {
    const token = `create-${crypto.randomUUID()}`;
    const createdName = "created-here";
    const createdPath = path.join(originDirectory, createdName);
    const externalName = "external.txt";

    await navigateTo(originDirectory);
    await waitForWatcherReady(originDirectory);
    await armCreateProbe(token, originDirectory);
    await beginCreate(createdName, token);

    await browser.waitUntil(() => fs.existsSync(createdPath), {
      timeout: 10_000,
      timeoutMsg: "native create did not reach the filesystem",
    });
    await browser.waitUntil(async () => {
      const probe = await mutationProbe();
      return probe?.token === token
        && probe.status === "held"
        && probe.resultPath === createdPath;
    }, {
      timeout: 10_000,
      timeoutMsg: "successful create result was not held before UI publication",
    });

    await navigateTo(destinationDirectory);
    await waitForWatcherReady(destinationDirectory);
    const receiptBefore = await watcherReceipt(destinationDirectory);

    await releaseMutation(token);
    const operation = await fileOperationResult(token);
    expect(operation.error ?? null).toBeNull();
    const namesAfterCompletion = await entryNames();
    const selectionAfterCompletion = await selectedPaths();

    const writeStartedAt = Date.now();
    expect(writeStartedAt - operation.completedAt).toBeGreaterThanOrEqual(0);
    expect(writeStartedAt - operation.completedAt).toBeLessThan(1_000);
    fs.writeFileSync(path.join(destinationDirectory, externalName), "external\n");
    await waitForCausalReceipt(
      destinationDirectory,
      receiptBefore.count,
      writeStartedAt,
    );

    try {
      await browser.waitUntil(async () => (await entryNames()).includes(externalName), {
        timeout: 15_000,
        timeoutMsg: "causally observed external file never appeared in destination listing",
      });
    } catch (error) {
      console.log(JSON.stringify({
        case: "local-create-navigation-lifetime-failure",
        operation,
        probe: await mutationProbe(),
        namesAfterCompletion,
        selectionAfterCompletion,
        currentNames: await entryNames(),
        currentSelection: await selectedPaths(),
        destinationReceipt: await watcherReceipt(destinationDirectory),
      }));
      throw error;
    }

    expect(namesAfterCompletion).not.toContain(createdName);
    expect(selectionAfterCompletion).toEqual([
      path.join(destinationDirectory, "b-seed.txt"),
    ]);
    expect(await entryNames()).toEqual(["b-seed.txt", externalName]);

    await navigateTo(originDirectory);
    await browser.waitUntil(async () => (await entryNames()).includes(createdName), {
      timeout: 10_000,
      timeoutMsg: "durable origin creation was missing after returning to A",
    });
  });
});
