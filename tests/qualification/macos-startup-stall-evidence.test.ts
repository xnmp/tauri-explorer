/** Bounded macOS evidence for a timed-out startup sample (#936). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureMacStartupStallEvidence,
  parseElapsedSeconds,
  runBoundedEvidenceCommand,
  selectStallProcesses,
  withStallEvidence,
  type EvidenceCommandRunner,
} from "../../e2e-tauri/native-qualification/stall-evidence";

const APP_PID = 4242;
const PS_TABLE = [
  "  PID  PPID  PGID STAT     ELAPSED    RSS  %CPU COMMAND",
  "    1     0     1 Ss    1-02:03:04  12000   0.0 /sbin/launchd",
  `${APP_PID}   900  ${APP_PID} S          00:31  90000   1.0 /Users/runner/work/tauri-explorer/src-tauri/target/release/tauri-explorer`,
  `4300  ${APP_PID}  ${APP_PID} S          00:30   1000   0.0 /bin/sh -c helper`,
  "5001     1  5001 S          00:29  60000  99.0 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
  "5002     1  5002 S          00:28  50000   0.0 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
  "5003     1  5003 S          00:20  20000   0.0 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking",
  "5004     1  5004 S       01:02:00  20000   0.0 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent",
  "6000     1  6000 S          00:10   1000   0.0 /usr/bin/unrelated",
].join("\n");

let root: string;
let reports: string;
const SAMPLE_STARTED = 1_000_000;
const CAPTURED = SAMPLE_STARTED + 31_000;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "stall-evidence-"));
  reports = path.join(root, "reports");
  fs.mkdirSync(path.join(reports, "Retired"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Scripted stand-in for the macOS tools: records every invocation. */
function scriptedRunner(
  behaviour: (command: string, args: readonly string[]) => { stdout?: string; report?: string; exitCode?: number },
): { run: EvidenceCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: EvidenceCommandRunner = async (command, args, { outputPath }) => {
    calls.push([command, ...args]);
    const { stdout = "", report, exitCode = 0 } = behaviour(command, args);
    fs.writeFileSync(outputPath, stdout);
    const fileIndex = args.indexOf("-file");
    if (report !== undefined && fileIndex >= 0) fs.writeFileSync(args[fileIndex + 1], report);
    return { exitCode, signal: null, timedOut: false, bytes: stdout.length, truncated: false };
  };
  return { run, calls };
}

function oldAndNewReports(): void {
  const old = path.join(reports, "old.ips");
  fs.writeFileSync(old, "stale");
  fs.utimesSync(old, new Date(SAMPLE_STARTED - 60_000), new Date(SAMPLE_STARTED - 60_000));
  const crash = path.join(reports, "com.apple.WebKit.WebContent-2026-09-30.ips");
  fs.writeFileSync(crash, "x".repeat(4096));
  fs.utimesSync(crash, new Date(SAMPLE_STARTED + 10_000), new Date(SAMPLE_STARTED + 10_000));
  const jetsam = path.join(reports, "Retired", "JetsamEvent-2026-09-30.ips");
  fs.writeFileSync(jetsam, "jetsam");
  fs.utimesSync(jetsam, new Date(SAMPLE_STARTED + 5_000), new Date(SAMPLE_STARTED + 5_000));
}

describe("stall process selection", () => {
  it("keeps the app, its children and WebKit, and picks this sample's renderers newest first", () => {
    const { lines, webContentPids } = selectStallProcesses(PS_TABLE, APP_PID, 31, 3);
    expect(lines[0]).toContain("PID");
    expect(lines.map((line) => Number(line.trim().split(/\s+/)[0])).slice(1)).toEqual([
      APP_PID, 4300, 5001, 5002, 5003, 5004,
    ]);
    // 5004 predates the sample: a leftover renderer is not this sample's.
    expect(webContentPids).toEqual([5002, 5001]);
    expect(selectStallProcesses(PS_TABLE, APP_PID, 31, 1).webContentPids).toEqual([5002]);
  });

  it("tolerates an empty or garbled table", () => {
    expect(selectStallProcesses("", APP_PID, 31, 3)).toEqual({ lines: [], webContentPids: [] });
    expect(selectStallProcesses("garbage\nmore garbage", null, 31, 3).webContentPids).toEqual([]);
  });

  it("parses ps elapsed times", () => {
    expect(parseElapsedSeconds("00:31")).toBe(31);
    expect(parseElapsedSeconds("01:02:03")).toBe(3723);
    expect(parseElapsedSeconds("2-01:00:00")).toBe(176_400);
    expect(parseElapsedSeconds("soon")).toBeNull();
  });
});

describe("stall evidence capture", () => {
  it("records processes, profiles, the unified log and new diagnostic reports inside the output directory", async () => {
    oldAndNewReports();
    const { run, calls } = scriptedRunner((command, args) => {
      if (command === "/bin/ps") return { stdout: PS_TABLE };
      if (command === "/usr/bin/sample" && args[0] === "5001") return { stdout: "cannot examine", exitCode: 1 };
      if (command === "/usr/bin/sample") return { report: `Call graph for ${args[0]}` };
      if (command === "/usr/bin/sudo") return { report: `spindump of ${args[2]}` };
      return { stdout: "log line\n" };
    });
    const result = await captureMacStartupStallEvidence({
      pid: APP_PID,
      binary: "/work/src-tauri/target/release/tauri-explorer",
      outputDir: root,
      directoryName: "sample-10-stall",
      sampleStartedAtMs: SAMPLE_STARTED,
      run,
      now: () => CAPTURED,
      diagnosticReportDirectories: [reports],
      limits: { maxDiagnosticReports: 1 },
    });

    expect(result.directory).toBe(path.join(root, "sample-10-stall"));
    const { summary } = result;
    expect(summary.webContentPids).toEqual([5002, 5001]);
    expect(Object.fromEntries(summary.captures.map((record) => [record.id, record.status]))).toEqual({
      ps: "captured",
      "sample:app:4242": "captured",
      "sample:webcontent:5002": "captured",
      "sample:webcontent:5001": "failed",
      "spindump:webcontent:5001": "captured",
      "log-show": "captured",
    });
    // A platform binary `sample` refuses falls back to non-interactive spindump.
    expect(calls).toContainEqual([
      "/usr/bin/sudo", "-n", "/usr/sbin/spindump", "5001", "3", "-file",
      path.join(result.directory, "spindump-webcontent-5001.txt"),
    ]);
    const logShow = calls.find(([command]) => command === "/usr/bin/log")!;
    expect(logShow).toEqual(expect.arrayContaining(["show", "--last", "60s"]));
    expect(logShow.at(-1)).toContain('process == "tauri-explorer"');

    const processes = fs.readFileSync(path.join(result.directory, "processes.txt"), "utf8");
    expect(processes).toContain("com.apple.WebKit.WebContent");
    expect(processes).not.toContain("/usr/bin/unrelated");
    expect(fs.existsSync(path.join(result.directory, "ps-full.txt.tmp"))).toBe(false);
    expect(fs.readFileSync(path.join(result.directory, "sample-app-4242.txt"), "utf8")).toBe(
      "Call graph for 4242",
    );
    // Only reports newer than the sample, newest first, bounded by count.
    expect(summary.diagnosticReports.copied).toEqual([
      path.join("sample-10-stall", "diagnostic-reports", "0-com.apple.WebKit.WebContent-2026-09-30.ips"),
    ]);
    expect(summary.diagnosticReports.omitted).toBe(1);
    const persisted = JSON.parse(fs.readFileSync(path.join(result.directory, "evidence.json"), "utf8"));
    expect(persisted.captures).toHaveLength(6);
    expect(persisted.incomplete).toBe(false);
    for (const record of summary.captures) {
      if (record.file) expect(path.resolve(root, record.file).startsWith(`${root}${path.sep}`)).toBe(true);
    }
  });

  it("flags reports that appeared only while the profiles ran", async () => {
    oldAndNewReports();
    const induced = path.join(reports, "Kernel_2026-09-30.gpuRestart");
    const { run } = scriptedRunner((command, args) => {
      if (command === "/bin/ps") return { stdout: PS_TABLE };
      // Suspending WebContent for a profile can itself trigger a GPU reset.
      if (command === "/usr/bin/sample" && args[0] === "5002") {
        fs.writeFileSync(induced, "GPU Reset");
      }
      return { report: "profile" };
    });
    const result = await captureMacStartupStallEvidence({
      pid: APP_PID,
      binary: "tauri-explorer",
      outputDir: root,
      directoryName: "sample-05-stall",
      sampleStartedAtMs: SAMPLE_STARTED,
      run,
      now: () => CAPTURED,
      diagnosticReportDirectories: [reports],
    });
    const { copied, duringCapture } = result.summary.diagnosticReports;
    expect(copied).toHaveLength(3);
    expect(duringCapture).toEqual([
      path.join("sample-05-stall", "diagnostic-reports", "0-Kernel_2026-09-30.gpuRestart"),
    ]);
    const error = await withStallEvidence(new Error("timeout"), root, async () => result);
    expect(error.message).toContain("3 new diagnostic report(s) (1 written during capture)");
  });

  it("bounds copied diagnostic reports and profile files by size", async () => {
    oldAndNewReports();
    const { run } = scriptedRunner((command) =>
      command === "/bin/ps" ? { stdout: PS_TABLE } : { report: "y".repeat(10_000), stdout: "" },
    );
    const { summary, directory } = await captureMacStartupStallEvidence({
      pid: APP_PID,
      binary: "tauri-explorer",
      outputDir: root,
      directoryName: "sample-01-stall",
      sampleStartedAtMs: SAMPLE_STARTED,
      run,
      now: () => CAPTURED,
      diagnosticReportDirectories: [reports],
      limits: { diagnosticReportMaxBytes: 100, sampleMaxBytes: 500 },
    });
    expect(fs.statSync(path.join(directory, "sample-app-4242.txt")).size).toBe(500);
    expect(summary.captures.find((record) => record.id === "sample:app:4242")?.truncated).toBe(true);
    for (const copied of summary.diagnosticReports.copied) {
      expect(fs.statSync(path.join(root, copied)).size).toBeLessThanOrEqual(100);
    }
  });

  it("records failing and throwing tools instead of throwing", async () => {
    const run: EvidenceCommandRunner = async (command) => {
      if (command === "/bin/ps") throw new Error("ps exploded");
      return { exitCode: 1, signal: null, timedOut: true, bytes: 0, truncated: false };
    };
    const { summary } = await captureMacStartupStallEvidence({
      pid: APP_PID,
      binary: "tauri-explorer",
      outputDir: root,
      directoryName: "sample-02-stall",
      sampleStartedAtMs: SAMPLE_STARTED,
      run,
      now: () => CAPTURED,
      diagnosticReportDirectories: [path.join(root, "missing")],
    });
    expect(summary.captures.find((record) => record.id === "ps")).toMatchObject({
      status: "failed",
      error: "Error: ps exploded",
    });
    expect(summary.captures.every((record) => record.status === "failed")).toBe(true);
    expect(summary.webContentPids).toEqual([]);
    expect(summary.diagnosticReports).toEqual({ copied: [], duringCapture: [], omitted: 0, errors: [] });
  });

  it("stops waiting at the overall deadline", async () => {
    const run: EvidenceCommandRunner = (command, _args, { outputPath }) => {
      if (command === "/bin/ps") {
        fs.writeFileSync(outputPath, PS_TABLE);
        return Promise.resolve({ exitCode: 0, signal: null, timedOut: false, bytes: 1, truncated: false });
      }
      return new Promise(() => {}); // a tool that never returns
    };
    const began = Date.now();
    const { summary } = await captureMacStartupStallEvidence({
      pid: APP_PID,
      binary: "tauri-explorer",
      outputDir: root,
      directoryName: "sample-03-stall",
      sampleStartedAtMs: began - 31_000,
      run,
      diagnosticReportDirectories: [],
      limits: { overallTimeoutMs: 50 },
    });
    expect(summary.incomplete).toBe(true);
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(fs.existsSync(path.join(root, "sample-03-stall", "evidence.json"))).toBe(true);
  });
});

describe("attaching evidence to a timeout", () => {
  const timeout = new Error("startup markers missing after 30000ms; main progress: last mark settings-ready");

  it("keeps the timeout first when the capture throws", async () => {
    const error = await withStallEvidence(timeout, root, () =>
      captureMacStartupStallEvidence({
        pid: APP_PID,
        binary: "tauri-explorer",
        outputDir: root,
        directoryName: "../escape",
        sampleStartedAtMs: SAMPLE_STARTED,
      }),
    );
    expect(error.message).toMatch(
      /^startup markers missing after 30000ms; main progress: last mark settings-ready; stall evidence capture failed: artifact path resolves outside qualification root/,
    );
    expect(error.cause).toBe(timeout);
  });

  it("appends a summary of what was captured", async () => {
    const { run } = scriptedRunner((command) => (command === "/bin/ps" ? { stdout: PS_TABLE } : { report: "ok" }));
    const error = await withStallEvidence(timeout, root, () =>
      captureMacStartupStallEvidence({
        pid: APP_PID,
        binary: "tauri-explorer",
        outputDir: root,
        directoryName: "sample-04-stall",
        sampleStartedAtMs: SAMPLE_STARTED,
        run,
        now: () => CAPTURED,
        diagnosticReportDirectories: [],
      }),
    );
    expect(error.message.startsWith(timeout.message)).toBe(true);
    expect(error.message).toContain("stall evidence in sample-04-stall: ps captured, sample:app:4242 captured");
    expect(error.message).toContain("0 new diagnostic report(s)");
  });
});

describe("bounded evidence command", () => {
  const output = () => path.join(root, "command.txt");

  it("truncates output at the byte cap and stops the command", async () => {
    const result = await runBoundedEvidenceCommand("/bin/sh", ["-c", "yes evidence"], {
      timeoutMs: 5_000,
      maxBytes: 1_000,
      outputPath: output(),
    });
    expect(result).toMatchObject({ truncated: true, bytes: 1_000, timedOut: false });
    expect(fs.statSync(output()).size).toBe(1_000);
  });

  it("kills a command that outlives its timeout", async () => {
    const began = Date.now();
    const result = await runBoundedEvidenceCommand("/bin/sh", ["-c", "sleep 10"], {
      timeoutMs: 100,
      maxBytes: 1_000,
      outputPath: output(),
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - began).toBeLessThan(3_000);
  });

  it("reports a missing tool as an error, not a rejection", async () => {
    const result = await runBoundedEvidenceCommand("/nonexistent/tool", [], {
      timeoutMs: 1_000,
      maxBytes: 1_000,
      outputPath: output(),
    });
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain("ENOENT");
  });

  it("captures stdout and stderr with the exit status", async () => {
    const result = await runBoundedEvidenceCommand("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], {
      timeoutMs: 5_000,
      maxBytes: 1_000,
      outputPath: output(),
    });
    expect(result.exitCode).toBe(3);
    expect(fs.readFileSync(output(), "utf8").split("\n").sort()).toEqual(["", "err", "out"]);
  });
});
