/** Real windows, native clipboard, and on-disk Paste outcomes for #835. */
import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readNativeClipboardPaths, writeExternalClipboardCopy } from "../native-clipboard";
import { createNativeFixtureDirectory } from "../native-qualification";
import { navigateTo, windowOperation, switchToWindowLabel, closeOtherWindows, entryNames, entryPathSelector } from "./helpers";

type Content = { entries: Array<{ path: string }>; operation: "copy" | "cut" } | null;
const root = createNativeFixtureDirectory("clipboard-two-windows-");
const a = path.join(root, "older.txt");
const b = path.join(root, "latest.txt");
const external = path.join(root, "external.txt");
const destinationA = path.join(root, "paste-in-A");
const destinationB = path.join(root, "paste-in-B");


function gate(file: string, phase: "hold" | "queued" | "started"): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${phase === "hold" ? "clipboard-hold" : phase}`);
}
async function beginPublish(operation: "copy" | "cut", name: string): Promise<string> {
  const token = crypto.randomUUID();
  await browser.execute((request) => {
    window.dispatchEvent(new CustomEvent("e2e-window-operation", { detail: request }));
  }, { token, op: `clipboard-${operation}`, target: name });
  return token;
}
async function finishPublish(token: string): Promise<void> {
  let response: { token?: string; result?: boolean; error?: string } = {};
  await browser.waitUntil(async () => {
    response = await browser.execute(() => JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}"));
    return response.token === token;
  }, { timeout: 15_000, timeoutMsg: "native publication never settled" });
  expect(response.error).toBeUndefined();
  expect(response.result).toBe(true);
}
async function waitGate(file: string, phase: "queued" | "started"): Promise<void> {
  await browser.waitUntil(() => fs.existsSync(gate(file, phase)), {
    timeout: 15_000, timeoutMsg: `native clipboard write never reached ${phase}`,
  });
}
function releaseGates(): void {
  for (const file of [a, b]) fs.rmSync(gate(file, "hold"), { force: true });
}
function armGates(): void {
  for (const file of [a, b]) {
    for (const phase of ["queued", "started"] as const) fs.rmSync(gate(file, phase), { force: true });
    fs.writeFileSync(gate(file, "hold"), "");
  }
}

async function expectSelection(file: string, operation: "copy" | "cut"): Promise<void> {
  await browser.waitUntil(async () => {
    const content = await windowOperation("clipboard-state") as Content;
    return content?.entries.length === 1 && content.entries[0].path === file && content.operation === operation;
  }, { timeout: 15_000, timeoutMsg: "renderer did not receive the latest native clipboard selection" });
}

async function evidence(name: string): Promise<void> {
  fs.mkdirSync("evidence", { recursive: true });
  await browser.saveScreenshot(`evidence/835-${process.platform}-${name}.png`);
}

describe("cross-window clipboard ownership", () => {
  let main: string;
  let child: string;
  before(async () => {
    fs.writeFileSync(a, "older payload\n");
    fs.writeFileSync(b, "latest payload\n");
    fs.writeFileSync(external, "external payload\n");
    fs.mkdirSync(destinationA);
    fs.mkdirSync(destinationB);
    await navigateTo(root);
    main = await browser.getWindowHandle();
    const opened = await windowOperation("fresh-open", root) as { label: string };
    child = await switchToWindowLabel(opened.label);
    await navigateTo(root);
  });
  afterEach(() => releaseGates());
  after(async () => { if (main) await closeOtherWindows(main); });

  if (process.platform === "win32") {
    const unicode = path.join(root, "資料 ' $literal.txt");
    // Each case owns its existing 60s test budget: two bounded cold shells
    // must not share that budget with the other independent cases.
    for (const [name, paths] of [
      ["empty", []],
      ["single Unicode", [unicode]],
      ["ordered multi-file Unicode", [external, unicode]],
    ] as const) {
      it(`the independent reader preserves ${name} file lists`, async () => {
        fs.writeFileSync(unicode, "Unicode clipboard payload\n");
        const seed = promisify(execFile);
        // An external WinForms owner supplies real native data. No app IPC or
        // mocked JSON can stand in for the reader's CF_HDROP/UTF-16 handling.
        await seed("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-Command", `
          $ErrorActionPreference = 'Stop'
          Add-Type -AssemblyName System.Windows.Forms
          $paths = @(ConvertFrom-Json -InputObject $env:CLIP_PATHS)
          if ($paths.Count -eq 0) {
            [System.Windows.Forms.Clipboard]::SetText('no file list')
          } else {
            $files = [System.Collections.Specialized.StringCollection]::new()
            $files.AddRange([string[]]$paths)
            [System.Windows.Forms.Clipboard]::SetFileDropList($files)
          }
        `], { env: { ...process.env, CLIP_PATHS: JSON.stringify(paths) }, timeout: 30_000, killSignal: "SIGKILL" });
        expect(await readNativeClipboardPaths()).toEqual(paths);
      });
    }
  }

  it("both windows receive B and paste B from the native clipboard", async () => {
    await browser.switchToWindow(main);
    armGates();
    const first = await beginPublish("copy", "older.txt");
    await waitGate(a, "started");
    await browser.switchToWindow(child);
    const second = await beginPublish("copy", "latest.txt");
    await waitGate(b, "queued");
    // Permit B first. The process-wide worker must keep it behind held A.
    fs.rmSync(gate(b, "hold"));
    await browser.pause(200);
    expect(await browser.execute(() => JSON.parse(document.documentElement.dataset.e2eWindowResult ?? "{}").token)).not.toBe(second);
    releaseGates();
    await finishPublish(second);
    await browser.switchToWindow(main);
    await finishPublish(first);
    expect(await readNativeClipboardPaths()).toEqual([b]);
    await browser.switchToWindow(child);
    await $(entryPathSelector(b)).click();
    await evidence("latest-copy-selection");
    for (const [handle, destination, label] of [[main, destinationA, "A"], [child, destinationB, "B"]]) {
      await browser.switchToWindow(handle);
      await expectSelection(b, "copy");
      await navigateTo(destination);
      expect(await windowOperation("clipboard-paste")).toBeNull();
      expect(fs.readdirSync(destination)).toEqual(["latest.txt"]);
      expect(fs.readFileSync(path.join(destination, "latest.txt"), "utf8")).toBe("latest payload\n");
      await browser.waitUntil(async () => (await entryNames()).includes("latest.txt"));
      await evidence(`copy-paste-${label}`);
    }
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
  });

  it("the latest Cut moves only B; an external Copy subsequently wins", async () => {
    await browser.switchToWindow(main);
    await navigateTo(root);
    armGates();
    const first = await beginPublish("cut", "older.txt");
    await waitGate(a, "started");
    await browser.switchToWindow(child);
    await navigateTo(root);
    const second = await beginPublish("cut", "latest.txt");
    await waitGate(b, "queued");
    // This time permit A first, then B only once it reaches the native gate.
    fs.rmSync(gate(a, "hold"));
    await waitGate(b, "started");
    fs.rmSync(gate(b, "hold"));
    await finishPublish(second);
    await browser.switchToWindow(main);
    await finishPublish(first);
    await browser.switchToWindow(child);
    await expectSelection(b, "cut");
    expect(await readNativeClipboardPaths()).toEqual([b]);
    await browser.switchToWindow(main);
    await expectSelection(b, "cut");
    const moved = path.join(root, "moved");
    fs.mkdirSync(moved);
    await navigateTo(moved);
    expect(await windowOperation("clipboard-paste")).toBeNull();
    expect(fs.readdirSync(moved)).toEqual(["latest.txt"]);
    expect(fs.readFileSync(path.join(moved, "latest.txt"), "utf8")).toBe("latest payload\n");
    expect(fs.existsSync(b)).toBe(false);
    expect(fs.existsSync(a)).toBe(true);
    await browser.waitUntil(async () => (await entryNames()).includes("latest.txt"));
    await evidence("cut-paste");
    await writeExternalClipboardCopy(external);
    expect(await windowOperation("clipboard-paste")).toBeNull();
    expect(fs.readFileSync(path.join(moved, "external.txt"), "utf8")).toBe("external payload\n");
    expect(fs.existsSync(external)).toBe(true);
  });

  it("publishes a settled Copy even when its originating window closes", async () => {
    await browser.switchToWindow(main);
    await navigateTo(root);
    expect(await windowOperation("clipboard-copy", "external.txt")).toBe(true);
    await browser.switchToWindow(child);
    await navigateTo(root);
    fs.writeFileSync(gate(a, "hold"), "");
    fs.rmSync(gate(a, "started"), { force: true });
    await beginPublish("copy", "older.txt");
    await waitGate(a, "started");
    await browser.closeWindow();
    releaseGates();
    await browser.switchToWindow(main);
    // This reads state only: a paste/snapshot here would mask a lost broadcast.
    await expectSelection(a, "copy");
    expect(await readNativeClipboardPaths()).toEqual([a]);
  });
});
