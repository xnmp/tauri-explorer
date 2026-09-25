/**
 * Native permanent deletion removes exactly the confirmed selection (#739).
 * The real backend stages each entry in a private sibling before removal, so
 * this verifies the user-visible outcome: selected rows and files are gone,
 * unselected siblings, link targets and bytes survive, no hidden staging
 * residue remains, and Undo cannot resurrect a permanently deleted entry.
 * Substitution races are covered deterministically by the Rust tests in
 * `src-tauri/test_support/permanent_delete.rs`.
 */
import { browser, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { entryNames, navigateTo } from "./helpers";
import { createNativeFixtureDirectory } from "../native-qualification";

interface FileOperationResult {
  token: string;
  status: "captured" | "completed";
  error: string | null;
}

async function dispatch(
  detail: { op: string; token: string; paths?: string[]; permanent?: boolean },
  expected: FileOperationResult["status"],
): Promise<FileOperationResult> {
  await browser.execute((operation) => {
    delete document.documentElement.dataset.e2eFileOperationResult;
    window.dispatchEvent(new CustomEvent("e2e-file-op", { detail: operation }));
  }, detail);
  await browser.waitUntil(async () => await browser.execute(
    (token: string, status: string) => {
      const encoded = document.documentElement.dataset.e2eFileOperationResult;
      if (!encoded) return false;
      const result = JSON.parse(encoded) as FileOperationResult;
      return result.token === token && result.status === status;
    },
    detail.token,
    expected,
  ), { timeout: 20_000, timeoutMsg: `${detail.op} did not acknowledge ${expected}` });
  const encoded = await browser.execute(() => document.documentElement.dataset.e2eFileOperationResult!);
  return JSON.parse(encoded) as FileOperationResult;
}

async function waitForListed(name: string, present: boolean): Promise<void> {
  await browser.waitUntil(async () => (await entryNames()).includes(name) === present, {
    timeout: 20_000,
    timeoutMsg: `${name} remained ${present ? "absent from" : "present in"} the file list`,
  });
}

describe("native permanent deletion", () => {
  it("removes only the confirmed entries and offers no Undo", async function () {
    this.timeout(120_000);
    const scratch = createNativeFixtureDirectory("permanent-delete-");
    const keep = path.join(scratch, "keep.txt");
    const file = path.join(scratch, "selected-file.txt");
    const tree = path.join(scratch, "selected-tree");
    const link = path.join(scratch, "selected-link");
    fs.writeFileSync(keep, "keep these bytes\n");
    fs.writeFileSync(file, "delete me\n");
    fs.mkdirSync(path.join(tree, "nested", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(tree, "nested", "deeper", "leaf.txt"), "leaf\n");
    // A link inside the selected tree must not lead deletion to its target.
    fs.symlinkSync(keep, path.join(tree, "nested", "to-keep"));
    fs.symlinkSync(keep, link);
    const keepIdentity = fs.statSync(keep).ino;

    await navigateTo(scratch);
    for (const name of ["keep.txt", "selected-file.txt", "selected-tree", "selected-link"]) {
      await waitForListed(name, true);
    }

    const token = `permanent-${crypto.randomUUID()}`;
    const selected = [file, tree, link];
    expect((await dispatch({ op: "capture-delete", paths: selected, token }, "captured")).error).toBeNull();
    const deletion = await dispatch(
      { op: "confirm-captured-delete", token, permanent: true },
      "completed",
    );
    expect(deletion.error).toBeNull();

    for (const name of ["selected-file.txt", "selected-tree", "selected-link"]) {
      await waitForListed(name, false);
    }
    await waitForListed("keep.txt", true);
    for (const entry of selected) expect(fs.lstatSync(entry, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readFileSync(keep, "utf8")).toBe("keep these bytes\n");
    expect(fs.statSync(keep).ino).toBe(keepIdentity);
    expect(fs.readdirSync(scratch).filter((name) => name.startsWith(".tauri-delete-"))).toEqual([]);

    await browser.saveScreenshot(path.join(
      process.cwd(),
      "screenshots/fix/permanent-delete-identity/permanent-delete-native.png",
    ));

    // Permanent deletion records no inverse: Undo must not recreate anything.
    await dispatch({ op: "undo", token: `undo-${crypto.randomUUID()}` }, "completed");
    await browser.pause(500);
    for (const entry of selected) expect(fs.lstatSync(entry, { throwIfNoEntry: false })).toBeUndefined();
    expect((await entryNames()).sort()).toEqual(["keep.txt"]);
  });
});
