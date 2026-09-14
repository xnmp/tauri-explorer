import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runTerminalKeyProbeDiagnostics,
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
  it("wires the native Ctrl+Q smoke spec through the diagnostic command boundary", () => {
    const config = fs.readFileSync(
      path.resolve("e2e-tauri/wdio.conf.ts"),
      "utf8",
    );

    expect(config).toContain('browser.overwriteCommand("keys"');
    expect(config).toContain("await terminalKeyProbeObserver!.captureBeforeKey()");
    expect(config).toContain("terminalKeyProbeObserver!.recordFailure(error)");
    expect(config).toContain("terminalKeyProbeObserver?.recordFailure(result.error)");
  });

  it("captures before Ctrl+Q and records process-only evidence when delivery fails", async () => {
    const calls: string[] = [];
    const records: TerminalKeyOwnershipDiagnostics[] = [];
    const expectedFailure = new Error("terminal-hosted key probe never received Ctrl+Q");

    await expect(runTerminalKeyProbeDiagnostics({
      captureProbe: async () => {
        calls.push("capture");
        return beforeKey.probe;
      },
      sendKey: async () => {
        calls.push("send-key");
      },
      waitForDelivery: async () => {
        calls.push("wait-for-delivery");
        throw expectedFailure;
      },
    }, {
      applicationPath: "/repo/tauri-explorer",
      directory: scratch(),
      now: () => 42,
      collectNative: () => ({ sampledAt: 42, application: [], webkit: [], driver: [] }),
      write: (record) => {
        calls.push(`write-${record.phase}`);
        records.push(record);
        return "/tmp/terminal-key.json";
      },
    })).rejects.toBe(expectedFailure);

    expect(calls).toEqual([
      "capture",
      "write-before-key",
      "send-key",
      "wait-for-delivery",
      "write-probe-failed",
    ]);
    expect(records).toEqual([
      expect.objectContaining({ phase: "before-key", probe: beforeKey.probe }),
      expect.objectContaining({
        phase: "probe-failed",
        probe: beforeKey.probe,
        error: expect.stringContaining("never received Ctrl+Q"),
      }),
    ]);
  });

  it("records a process-only failure when the Ctrl+Q command itself rejects", async () => {
    const calls: string[] = [];
    const records: TerminalKeyOwnershipDiagnostics[] = [];
    const expectedFailure = new Error("invalid session id while sending Ctrl+Q");

    await expect(runTerminalKeyProbeDiagnostics({
      captureProbe: async () => {
        calls.push("capture");
        return beforeKey.probe;
      },
      sendKey: async () => {
        calls.push("send-key");
        throw expectedFailure;
      },
      waitForDelivery: async () => {
        calls.push("wait-for-delivery");
      },
    }, {
      applicationPath: "/repo/tauri-explorer",
      directory: scratch(),
      now: () => 43,
      collectNative: () => ({ sampledAt: 43, application: [], webkit: [], driver: [] }),
      write: (record) => {
        calls.push(`write-${record.phase}`);
        records.push(record);
        return "/tmp/terminal-key.json";
      },
    })).rejects.toBe(expectedFailure);

    expect(calls).toEqual(["capture", "write-before-key", "send-key", "write-probe-failed"]);
    expect(records.at(-1)).toEqual(expect.objectContaining({
      phase: "probe-failed",
      error: expect.stringContaining("invalid session id"),
    }));
  });

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
