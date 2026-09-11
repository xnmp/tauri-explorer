/**
 * A cross-device move whose destination commits before source cleanup fails
 * must remain visible and must not acquire an unsafe normal Move inverse.
 *
 * Linux-only: the fixture relies on $HOME and /dev/shm being distinct mounts
 * and on ordinary non-root directory permission enforcement.
 */
import { browser, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { entryNames, navigateTo } from "./helpers";

interface FileOperationResult {
  token: string;
  status: "completed";
  completedAt: number;
  error: string | null;
}

const operationResults: FileOperationResult[] = [];

async function dispatchOperation(detail: {
  op: "cut" | "paste" | "undo" | "redo";
  path?: string;
  paths?: string[];
  token: string;
}): Promise<FileOperationResult> {
  await browser.execute((operation) => {
    delete document.documentElement.dataset.e2eFileOperationResult;
    window.dispatchEvent(new CustomEvent("e2e-file-op", { detail: operation }));
  }, detail);

  await browser.waitUntil(async () => await browser.execute(
    (operationToken: string) => {
      const encoded = document.documentElement.dataset.e2eFileOperationResult;
      if (!encoded) return false;
      const result = JSON.parse(encoded) as FileOperationResult;
      return result.token === operationToken && result.status === "completed";
    },
    detail.token,
  ), {
    timeout: 30_000,
    timeoutMsg: `${detail.op} did not acknowledge completion`,
  });

  const encoded = await browser.execute(
    () => document.documentElement.dataset.e2eFileOperationResult!,
  );
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

function assertTree(root: string, expected: Readonly<Record<string, string>>): void {
  expect(fs.readdirSync(root).sort()).toEqual(Object.keys(expected).sort());
  for (const [name, contents] of Object.entries(expected)) {
    expect(fs.readFileSync(path.join(root, name), "utf8")).toBe(contents);
  }
}

/** Only traverse this test's owned fixture roots; never follow symlinks.
 * Failed publication may retain a read-only staged directory as well. */
function makeFixtureRemovable(root: string): void {
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()) return;
  fs.chmodSync(root, 0o700);
  for (const child of fs.readdirSync(root, { withFileTypes: true })) {
    if (child.isDirectory()) makeFixtureRemovable(path.join(root, child.name));
  }
}

const linuxDescribe = process.platform === "linux" ? describe : describe.skip;

linuxDescribe(
  "native cross-device move recovery (skipped outside Linux: requires /dev/shm permission semantics)",
  () => {
    let sourceParent = "";
    let sourceTree = "";
    let destinationParent = "";
    let destinationTree = "";
    const suffix = crypto.randomUUID().slice(0, 8);
    const treeName = `partial-move-${suffix}`;
    const contents = {
      "alpha.txt": `alpha ${suffix}\n`,
      "beta.txt": `beta ${suffix}\n`,
    } as const;

    before(() => {
      if (process.getuid?.() === undefined || process.getuid() === 0) {
        throw new Error("cross-device cleanup acceptance requires a non-root Linux process");
      }
      if (!fs.existsSync("/dev/shm")) {
        throw new Error("cross-device cleanup acceptance requires /dev/shm");
      }

      sourceParent = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-move-source-"));
      destinationParent = fs.mkdtempSync("/dev/shm/tauri-explorer-move-destination-");
      sourceTree = path.join(sourceParent, treeName);
      destinationTree = path.join(destinationParent, treeName);
      fs.mkdirSync(sourceTree);
      for (const [name, value] of Object.entries(contents)) {
        fs.writeFileSync(path.join(sourceTree, name), value);
      }

      const sourceDevice = fs.statSync(sourceTree).dev;
      const destinationDevice = fs.statSync(destinationParent).dev;
      if (sourceDevice === destinationDevice) {
        throw new Error(`expected distinct filesystems, both fixtures use device ${sourceDevice}`);
      }

      // Copying remains readable, but remove_dir_all cannot unlink children
      // from this directory as the non-root application user.
      fs.chmodSync(sourceTree, 0o555);
    });

    after(() => {
      // Restore traversal/write permission before deleting only these fixtures,
      // including when an assertion or native operation failed.
      for (const root of [sourceParent, destinationParent]) {
        if (root) makeFixtureRemovable(root);
      }
      if (sourceParent) fs.rmSync(sourceParent, { recursive: true, force: true });
      if (destinationParent) fs.rmSync(destinationParent, { recursive: true, force: true });
    });

    it("keeps both truthful copies and rejects undo after source cleanup fails", async function () {
      this.timeout(120_000);
      try {
        await navigateTo(sourceParent);
        await waitForListed(treeName, true);

        const cut = await dispatchOperation({
          op: "cut",
          path: sourceTree,
          token: `cut-${crypto.randomUUID()}`,
        });
        expect(cut.error).toBeNull();

        await navigateTo(destinationParent);
        const paste = await dispatchOperation({
          op: "paste",
          token: `paste-${crypto.randomUUID()}`,
        });

        expect(paste.error).not.toBeNull();
        expect(paste.error).toContain(destinationTree);
        expect(paste.error).toContain(sourceTree);
        expect(paste.error).toMatch(/copied/i);
        expect(paste.error).toMatch(/remov(?:e|ing).*did not finish/i);
        expect(paste.error).toMatch(/inspect both locations/i);

        await waitForListed(treeName, true);
        assertTree(destinationTree, contents);
        assertTree(sourceTree, contents);

        const proof = path.join(process.cwd(), "screenshots/refactor/repo-health-cleanup/partial-move-recovery.png");
        fs.mkdirSync(path.dirname(proof), { recursive: true });
        await browser.saveScreenshot(proof);

        const undo = await dispatchOperation({
          op: "undo",
          token: `undo-${crypto.randomUUID()}`,
        });
        expect(undo.error).toMatch(/nothing to undo/i);
        assertTree(destinationTree, contents);
        assertTree(sourceTree, contents);
        await waitForListed(treeName, true);
      } catch (error) {
        console.error(JSON.stringify({
          case: "file-move-recovery-failure",
          error: String(error),
          sourceTree,
          destinationTree,
          sourceExists: sourceTree ? fs.existsSync(sourceTree) : false,
          destinationExists: destinationTree ? fs.existsSync(destinationTree) : false,
          sourceEntries: sourceTree && fs.existsSync(sourceTree) ? fs.readdirSync(sourceTree) : null,
          destinationEntries: destinationTree && fs.existsSync(destinationTree)
            ? fs.readdirSync(destinationTree)
            : null,
          currentEntries: await entryNames(),
          operationResults,
        }));
        throw error;
      }
    });

    it("moves a multi-item selection in one session and undoes the whole prefix", async function () {
      this.timeout(90_000);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-ordered-move-"));
      const origin = path.join(root, "origin");
      const destination = path.join(root, "destination");
      const files = {
        "first.txt": "first ordered payload",
        "second.txt": "second ordered payload",
        "third.txt": "third ordered payload",
      } as const;
      fs.mkdirSync(origin, { recursive: true });
      fs.mkdirSync(destination);
      for (const [name, value] of Object.entries(files)) {
        fs.writeFileSync(path.join(origin, name), value);
      }
      try {
        await navigateTo(origin);
        for (const name of Object.keys(files)) await waitForListed(name, true);

        const cut = await dispatchOperation({
          op: "cut",
          paths: Object.keys(files).map((name) => path.join(origin, name)),
          token: crypto.randomUUID(),
        });
        expect(cut.error).toBeNull();

        await navigateTo(destination);
        expect((await dispatchOperation({ op: "paste", token: crypto.randomUUID() })).error).toBeNull();

        // Every item arrived and every source name was vacated: a move, not a copy.
        assertTree(destination, files);
        expect(fs.readdirSync(origin)).toEqual([]);
        for (const name of Object.keys(files)) await waitForListed(name, true);

        await browser.saveScreenshot(
          path.join(process.cwd(), "screenshots/feat/685-durable-move-recovery/ordered-move-session.png"),
        );

        // The whole session is one native history entry, so a single Undo
        // returns the complete prefix rather than one item at a time.
        expect((await dispatchOperation({ op: "undo", token: crypto.randomUUID() })).error).toBeNull();
        assertTree(origin, files);
        expect(fs.readdirSync(destination)).toEqual([]);
        for (const name of Object.keys(files)) await waitForListed(name, false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("moves a tree through admitted cut/paste and repeats native Undo/Redo", async function () {
      this.timeout(60_000);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-admitted-move-"));
      const origin = path.join(root, "origin");
      const destination = path.join(root, "destination");
      const name = "moved-tree";
      const source = path.join(origin, name);
      const target = path.join(destination, name);
      const files = { "one.txt": "first moved payload", "two.txt": "second moved payload" };
      fs.mkdirSync(source, { recursive: true });
      fs.mkdirSync(destination);
      for (const [file, contents] of Object.entries(files)) fs.writeFileSync(path.join(source, file), contents);
      try {
        await navigateTo(origin);
        await waitForListed(name, true);
        expect((await dispatchOperation({ op: "cut", path: source, token: crypto.randomUUID() })).error).toBeNull();
        await navigateTo(destination);
        expect((await dispatchOperation({ op: "paste", token: crypto.randomUUID() })).error).toBeNull();
        assertTree(target, files);
        expect(fs.existsSync(source)).toBe(false);
        await waitForListed(name, true);
        for (let cycle = 0; cycle < 2; cycle++) {
          expect((await dispatchOperation({ op: "undo", token: crypto.randomUUID() })).error).toBeNull();
          assertTree(source, files);
          expect(fs.existsSync(target)).toBe(false);
          await waitForListed(name, false);
          expect((await dispatchOperation({ op: "redo", token: crypto.randomUUID() })).error).toBeNull();
          assertTree(target, files);
          expect(fs.existsSync(source)).toBe(false);
          await waitForListed(name, true);
        }
        await browser.saveScreenshot(path.join(process.cwd(), "screenshots/refactor/repo-health-cleanup/native-admitted-move-redone.png"));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
