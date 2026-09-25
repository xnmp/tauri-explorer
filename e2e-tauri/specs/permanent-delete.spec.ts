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
import { navigateTo } from "./helpers";
import { createNativeFixtureDirectory } from "../native-qualification";

interface FileOperationResult {
  token: string;
  status: "captured" | "completed";
  error: string | null;
}

async function dispatch(
  detail: { op: string; token: string; path?: string; name?: string; paths?: string[]; permanent?: boolean },
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

// Session state persists across launches, so an earlier spec can leave a
// split pane restored beside this one; read only the pane under test. Only a
// split marks its active pane, so a single pane is read as-is.
async function activeEntryNames(): Promise<string[]> {
  return await browser.execute(() => {
    const pane = document.querySelector(".explorer-pane.active")
      ?? document.querySelector(".explorer-pane");
    return Array.from(pane?.querySelectorAll(".entry-item .entry-name") ?? [], (el) => el.textContent?.trim() ?? "");
  });
}

async function waitForListed(name: string, present: boolean): Promise<void> {
  await browser.waitUntil(async () => (await activeEntryNames()).includes(name) === present, {
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
    // File history persists across app launches, so an earlier spec's entry
    // could otherwise sit on top of the stack. A reversible rename recorded
    // just before the deletion makes the expected Undo target this test's own.
    const sentinel = path.join(scratch, "sentinel-before");
    fs.mkdirSync(sentinel);

    await navigateTo(scratch);
    for (const name of ["keep.txt", "selected-file.txt", "selected-tree", "selected-link", "sentinel-before"]) {
      await waitForListed(name, true);
    }
    const renamed = await dispatch(
      { op: "rename", path: sentinel, name: "sentinel-after", token: `rename-${crypto.randomUUID()}` },
      "completed",
    );
    expect(renamed.error).toBeNull();
    await waitForListed("sentinel-after", true);

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

    // Permanent deletion records no inverse, so Undo skips past it to the
    // sentinel rename and recreates none of the deleted entries.
    const undone = await dispatch({ op: "undo", token: `undo-${crypto.randomUUID()}` }, "completed");
    expect(undone.error).toBeNull();
    await waitForListed("sentinel-before", true);
    for (const entry of selected) expect(fs.lstatSync(entry, { throwIfNoEntry: false })).toBeUndefined();
    expect(fs.readdirSync(scratch).sort()).toEqual(["keep.txt", "sentinel-before"]);
    expect((await activeEntryNames()).sort()).toEqual(["keep.txt", "sentinel-before"]);
  });
});
