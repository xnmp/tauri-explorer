import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeTerminalKeyOwnershipDiagnostics,
  type TerminalKeyOwnershipDiagnostics,
} from "../../e2e-tauri/terminal-key-diagnostics";

const scratchDirectories: string[] = [];

function scratch(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-key-diagnostics-"));
  scratchDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (scratchDirectories.length > 0) {
    fs.rmSync(scratchDirectories.pop()!, { recursive: true, force: true });
  }
});

const beforeKey: TerminalKeyOwnershipDiagnostics = {
  issue: 709,
  phase: "before-key",
  capturedAt: 1_789_001_536_699,
  probe: {
    terminalText: "key-probe-ready",
    activeElement: { tag: "TEXTAREA", classes: "xterm-helper-textarea" },
    terminalDisplayed: true,
    modalText: null,
  },
  native: { sampledAt: 1, application: [], webkit: [], driver: [] },
};

describe("terminal key probe diagnostic artifacts", () => {
  it("retains the pre-key focus state and post-failure driver evidence", () => {
    const directory = path.join(scratch(), "logs", "terminal-key-ownership");
    const preKeyPath = writeTerminalKeyOwnershipDiagnostics(beforeKey, directory);
    const failurePath = writeTerminalKeyOwnershipDiagnostics({
      ...beforeKey,
      phase: "probe-failed",
      capturedAt: 1_789_001_551_699,
      error: "terminal-hosted key probe never received Ctrl+Q",
      native: { sampledAt: 2, application: [], webkit: [], driver: [] },
    }, directory);

    expect(preKeyPath).not.toBeNull();
    expect(failurePath).not.toBeNull();
    const preKey = JSON.parse(fs.readFileSync(preKeyPath!, "utf8")) as TerminalKeyOwnershipDiagnostics;
    const failure = JSON.parse(fs.readFileSync(failurePath!, "utf8")) as TerminalKeyOwnershipDiagnostics;
    expect(preKey.probe).toEqual(beforeKey.probe);
    expect(failure.error).toContain("never received Ctrl+Q");
    expect(failure.native).toEqual({ sampledAt: 2, application: [], webkit: [], driver: [] });
  });

  it("does not obscure the native test failure when diagnostics cannot be written", () => {
    const occupiedPath = path.join(scratch(), "occupied");
    fs.writeFileSync(occupiedPath, "not a directory");
    expect(writeTerminalKeyOwnershipDiagnostics(beforeKey, occupiedPath)).toBeNull();
  });
});
