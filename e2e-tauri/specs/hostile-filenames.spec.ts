/**
 * Adversarial filenames against the real backend (#198).
 *
 * Names carrying quotes, spaces, emoji, RTL marks, URL-hostile characters
 * and long runs must list, rename and trash cleanly. Escaping/encoding bugs
 * here live in the Rust/OS boundary, which mock-mode e2e never touches.
 * Windows-invalid characters (e.g. ") are filtered per-platform.
 */
import { browser, expect } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { navigateTo, entryNames } from "./helpers";

const isWindows = process.platform === "win32";
const scratchDir = fs.mkdtempSync(path.join(os.homedir(), ".tauri-explorer-e2e-hostile-"));

/** Adversarial but creatable-on-this-OS names. */
const HOSTILE_NAMES = [
  "with spaces and  double  spaces.txt",
  "single'quote.txt",
  "emoji-🍌🚀.txt",
  "rtl-‮gnp.txt", // RIGHT-TO-LEFT OVERRIDE embedded
  "url-hostile-#%&+=@!.txt",
  "dots...and...more.txt",
  `long-${"x".repeat(180)}.txt`,
  ...(isWindows ? [] : ['double"quote.txt', "back\\slash.txt", "newline\nname.txt"]),
];

async function fileOp(detail: { op: string; name?: string; path?: string }): Promise<void> {
  await browser.execute((d) => {
    window.dispatchEvent(new CustomEvent("e2e-file-op", { detail: d }));
  }, detail);
}

describe("hostile filenames on the real backend", () => {
  before(() => {
    for (const name of HOSTILE_NAMES) {
      fs.writeFileSync(path.join(scratchDir, name), "payload\n");
    }
  });

  after(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("lists every adversarial name verbatim", async () => {
    await navigateTo(scratchDir);

    await browser.waitUntil(
      async () => (await entryNames()).length >= HOSTILE_NAMES.length,
      { timeoutMsg: "listing never showed all hostile entries" },
    );
    const names = await entryNames();
    for (const name of HOSTILE_NAMES) {
      expect(names).toContain(name);
    }
  });

  it("renames a quoted+emoji name to another hostile name", async () => {
    const from = "emoji-🍌🚀.txt";
    const to = "renamed 'quote' 🎯 #tag.txt";
    await fileOp({ op: "rename", path: path.join(scratchDir, from), name: to });

    await browser.waitUntil(async () => (await entryNames()).includes(to), {
      timeoutMsg: "hostile rename never appeared",
    });
    expect(fs.existsSync(path.join(scratchDir, to))).toBe(true);
    expect(fs.existsSync(path.join(scratchDir, from))).toBe(false);
    expect(fs.readFileSync(path.join(scratchDir, to), "utf8")).toBe("payload\n");
  });

  it("trashes a URL-hostile name", async () => {
    const victim = "url-hostile-#%&+=@!.txt";
    await fileOp({ op: "delete", path: path.join(scratchDir, victim) });

    await browser.waitUntil(async () => !(await entryNames()).includes(victim), {
      timeoutMsg: "hostile-name trash never removed the entry",
    });
    expect(fs.existsSync(path.join(scratchDir, victim))).toBe(false);
  });
});
