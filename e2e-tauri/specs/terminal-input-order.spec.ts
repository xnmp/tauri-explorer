import { browser, $ } from "@wdio/globals";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createNativeFixtureDirectory } from "../native-qualification";
import { domText } from "./helpers";

/**
 * Keystrokes reach the PTY in the order xterm emitted them (#709). Each xterm
 * `onData` chunk crosses IPC separately; nothing may let a later chunk
 * overtake an earlier one on its way to the shell. A burst of distinct
 * characters is typed into `cat` and the written file must match exactly.
 */

type TerminalInput = ReturnType<typeof $>;

async function terminalText(): Promise<string> {
  return domText(".terminal-panel .xterm-rows");
}

function burstPayload(lines: number, width: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: lines }, (_, line) =>
    Array.from({ length: width }, (_, column) => alphabet[(line * 7 + column) % alphabet.length]).join(""),
  ).join("\n");
}

async function openTerminal(): Promise<TerminalInput> {
  await $(".file-list").waitForExist({ timeout: 15_000 });
  if (!(await $(".terminal-panel").isDisplayed())) {
    await browser.keys(["Control", "`"]);
  }
  await $(".terminal-panel .xterm").waitForDisplayed({ timeout: 10_000 });
  const input = await $(".terminal-panel textarea.xterm-helper-textarea");
  await input.waitForExist();
  await browser.waitUntil(async () => (await terminalText()).trim().length > 0, {
    timeout: 45_000,
    timeoutMsg: "shell never became ready for the input-order probe",
  });
  await browser.execute((element: HTMLElement) => element.focus(), input);
  return input;
}

/** Start `cat`, deliver `payload` through `deliver`, and return what cat wrote. */
async function catReceives(
  input: TerminalInput,
  label: string,
  payload: string,
  deliver: (text: string) => Promise<void>,
): Promise<string> {
  const scratch = createNativeFixtureDirectory(`terminal-input-order-${label}-`);
  const output = join(scratch, "typed.txt");
  const done = join(scratch, "done");
  const marker = `${label}-probe-ready`;

  // Wait until the shell has handed `cat` a cooked-mode tty. Keys typed ahead
  // while the line editor still owns a raw-mode tty are queued without CR→NL
  // translation, which would corrupt the file for a reason unrelated to
  // ordering. The marker is assembled by the command so its own echo cannot
  // satisfy the wait.
  await input.addValue(`printf '%s-%s\\n' ${label} probe-ready; cat > '${output}'; touch '${done}'\n`);
  await browser.waitUntil(async () => (await terminalText()).includes(marker), {
    timeout: 15_000,
    timeoutMsg: `the typed cat command for ${label} never started`,
  });

  await deliver(`${payload}\n`);
  await browser.keys(["Control", "d"]);
  await browser.waitUntil(() => existsSync(done), {
    timeout: 30_000,
    timeoutMsg: `cat never reached end of input for ${label}`,
  });
  return readFileSync(output, "utf8");
}

function expectInOrder(written: string, expected: string): void {
  if (written === expected) return;
  // The first differing offset; a prefix match means one side ran long.
  const length = Math.min(written.length, expected.length);
  const found = Array.from({ length }, (_, position) => position).find(
    (position) => written[position] !== expected[position],
  );
  const index = found ?? length;
  throw new Error(
    `typed input reached the PTY out of order at offset ${index} ` +
      `(wrote ${written.length} of ${expected.length} characters): ` +
      `expected ${JSON.stringify(expected.slice(Math.max(0, index - 8), index + 8))}, ` +
      `got ${JSON.stringify(written.slice(Math.max(0, index - 8), index + 8))}`,
  );
}

(process.platform !== "win32" ? describe : describe.skip)("terminal input order (#709)", () => {
  let input: TerminalInput;

  // Shell startup gets its own mocha budget: on CI it regularly takes most of
  // a minute, and must not be charged to the ordering cases.
  it("opens a ready shell", async () => {
    input = await openTerminal();
  });

  it("delivers a WebDriver keystroke burst to the shell in order", async () => {
    const payload = burstPayload(40, 72);
    // One Send Keys payload: the driver emits keys faster than a write round
    // trip, which is the burst a fast typist, key repeat or an input method
    // produces.
    const written = await catReceives(input, "driver", payload, (text) => input.addValue(text));
    expectInOrder(written, `${payload}\n`);
  });

  it("delivers xterm data emitted in a single task in order", async () => {
    const payload = burstPayload(40, 72);
    // Every chunk is emitted before the first write can complete, so each one
    // is in flight at once. This is the ordering contract without depending
    // on the driver's key pacing.
    const written = await catReceives(input, "task", payload, async (text) => {
      await browser.execute((element: HTMLElement, data: string) => {
        for (const character of data) {
          element.dispatchEvent(new InputEvent("input", {
            data: character === "\n" ? "\r" : character,
            inputType: "insertText",
          }));
        }
      }, input, text);
    });
    expectInOrder(written, `${payload}\n`);
  });
});
