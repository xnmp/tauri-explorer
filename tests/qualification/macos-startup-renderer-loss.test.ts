/**
 * Renderer loss fails a macOS startup sample (#942). The fixtures are the
 * retained #936 CI logs (run 36790425556): foreground sample 10 completed
 * every marker and then lost its renderer 8.7 ms later, and was reported as a
 * pass; warm-probe sample 9 lost it before ui-ready and waited out 30 s.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findRendererTerminations,
  logBeforeRendererLoss,
  MacRendererLossError,
  parseAttributedMacStartupLog,
  parseCrashReportIdentity,
  parseWebPageProcesses,
  waitForMacStartupProcess,
  type NativeStartupChild,
} from "../../e2e-tauri/native-qualification";
import {
  captureMacStartupStallEvidence,
  runBoundedEvidenceCommand,
  selectStallProcesses,
  terminatedWebContentProcesses,
  unifiedLogPredicate,
  withStallEvidence,
  type EvidenceCommandRunner,
} from "../../e2e-tauri/native-qualification/stall-evidence";

const line = (level: string, target: string, message: string) =>
  `[2026-09-30][23:43:15][${level}][${target}] ${message}`;
const SYSTEM = "tauri_explorer_lib::system";

/** Foreground sample 10: complete, then the renderer died (reported as PASS). */
const COMPLETED_THEN_LOST = [
  line("INFO", "tauri_explorer_lib", "Startup(native-window): window=main app-run-epoch-ms=1790811793552.789 process-entry-to-run=0.1ms window-built=250.0ms"),
  line("INFO", SYSTEM, "Startup(webview-progress): window=main mark=app-ready webview-ms=407.0 app-run-ms=1816.1"),
  line("INFO", SYSTEM, "Startup(webview-progress): window=main mark=ui-ready webview-ms=1021.0 app-run-ms=2430.5"),
  line("INFO", SYSTEM, "Startup(webview): window=main boot-epoch-ms=1790811794961.000 bundle-exec=216.0ms mount=321.0ms commands-ready=333.0ms settings-ready=362.0ms list-ready=406.0ms app-ready=407.0ms ui-ready=1021.0ms total=1021.0ms"),
  line("INFO", SYSTEM, "Startup(native-ready): window=main app-run-to-ready=2431.2ms receipt-epoch-ms=1790811795985.206"),
];
const LOST = line("WARN", "tauri_explorer_lib::renderer_owner",
  "Renderer(web-content-terminated): window=main webview=main epoch-ms=1790811795993.919 app-run-ms=2439.9");
const RELOADED = line("WARN", "tauri_explorer_lib::renderer_owner::reload",
  "Renderer(recovery): window=main webview=main decision=reload attempt=1 limit=3 period-s=60");
/** What the reloaded document logs on its second boot. */
const SECOND_BOOT = [
  line("INFO", SYSTEM, "Startup(webview-progress): window=main mark=bundle-exec webview-ms=120.0 app-run-ms=2700.0"),
  line("INFO", SYSTEM, "Startup(webview): window=main boot-epoch-ms=1790811796200.000 bundle-exec=120.0ms mount=200.0ms commands-ready=210.0ms settings-ready=230.0ms list-ready=260.0ms app-ready=261.0ms ui-ready=300.0ms total=300.0ms"),
  line("INFO", SYSTEM, "Startup(native-ready): window=main app-run-to-ready=3100.0ms receipt-epoch-ms=1790811796501.000"),
];

/** Warm-probe sample 9: lost after app-ready, before ui-ready. */
const LOST_BEFORE_READY = [
  line("INFO", "tauri_explorer_lib", "Startup(native-window): window=main app-run-epoch-ms=1790812005995.797 process-entry-to-run=0.1ms window-built=222.7ms"),
  line("INFO", SYSTEM, "Startup(webview-progress): window=main mark=settings-ready webview-ms=346.0 app-run-ms=1726.0"),
  line("INFO", SYSTEM, "Startup(webview-progress): window=main mark=app-ready webview-ms=386.0 app-run-ms=1773.4"),
  line("WARN", "tauri_explorer_lib", "Renderer(web-content-terminated): window=main webview=main epoch-ms=1790812008372.732 app-run-ms=2376.9"),
].join("\n");

const foreground = {
  firstFunctionalFrame: "not-observed",
  firstFunctionalFrameMs: null,
  inputOutcome: "not-verified",
  inputReadyMs: null,
  measureWarm: false,
} as const;

class FakeStartupChild extends EventEmitter implements NativeStartupChild {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("renderer termination lines", () => {
  it("are found with their window, clocks and the app's recovery decision", () => {
    expect(findRendererTerminations([...COMPLETED_THEN_LOST, LOST, RELOADED].join("\n"))).toEqual([{
      window: "main",
      webview: "main",
      epochMs: 1790811795993.919,
      appRunMs: 2439.9,
      recovery: "decision=reload attempt=1 limit=3 period-s=60",
      line: LOST,
    }]);
  });

  it("count even when their fields drift from the expected format", () => {
    const drifted = findRendererTerminations("x Renderer(web-content-terminated) something changed\n");
    expect(drifted).toHaveLength(1);
    expect(drifted[0]).toMatchObject({ window: null, appRunMs: null, recovery: null });
    expect(new MacRendererLossError(drifted, "").message).toMatch(
      /^renderer lost: window=unknown WebContent terminated at an unrecorded time \(no recovery decision logged\)/,
    );
  });

  it("attribute each recovery decision to its own window", () => {
    const log = [
      "Renderer(web-content-terminated): window=explorer-warm-measure webview=explorer-warm-measure epoch-ms=1 app-run-ms=2",
      "Renderer(recovery): window=main webview=main decision=reload attempt=1 limit=3 period-s=60",
      "Renderer(recovery): window=explorer-warm-measure webview=explorer-warm-measure decision=retire-parked",
    ].join("\n");
    expect(findRendererTerminations(log)[0].recovery).toBe("decision=retire-parked");
  });

  it("delimit the lost document so a reload's marks are not attributed to it", () => {
    const log = [...COMPLETED_THEN_LOST, LOST, RELOADED, ...SECOND_BOOT].join("\n");
    expect(logBeforeRendererLoss(log)).toBe(`${COMPLETED_THEN_LOST.join("\n")}\n`);
    expect(logBeforeRendererLoss("no loss")).toBe("no loss");
  });
});

describe("the attributed startup parser", () => {
  it("measured the #936 sample that completed and then lost its renderer", () => {
    // The pre-#942 outcome, kept as the control for the next assertion.
    expect(parseAttributedMacStartupLog(COMPLETED_THEN_LOST.join("\n"), foreground).readinessTotalMs).toBe(2431.2);
  });

  it("rejects that sample once the loss is in its log, reload or not", () => {
    for (const log of [
      [...COMPLETED_THEN_LOST, LOST],
      [...COMPLETED_THEN_LOST, LOST, RELOADED, ...SECOND_BOOT],
    ]) {
      expect(() => parseAttributedMacStartupLog(log.join("\n"), foreground)).toThrow(MacRendererLossError);
    }
  });

  it("refuses markers from two main-window documents even without a termination line", () => {
    expect(() => parseAttributedMacStartupLog([...COMPLETED_THEN_LOST, ...SECOND_BOOT].join("\n"), foreground))
      .toThrow("Startup(webview) is recorded by more than one main-window document");
    expect(() => parseAttributedMacStartupLog([...COMPLETED_THEN_LOST, SECOND_BOOT[2]].join("\n"), foreground))
      .toThrow("Startup(native-ready) is recorded by more than one main-window document");
  });
});

describe("waiting for a startup sample", () => {
  const options = { timeoutMs: 30_000, survivalMs: 5_000, pollMs: 25, measureWarm: false };

  it("fails at once when the renderer dies before readiness, naming the last mark of the lost document", async () => {
    vi.useFakeTimers();
    let log = LOST_BEFORE_READY;
    const result = waitForMacStartupProcess(new FakeStartupChild(), () => log, options);
    const assertion = expect(result).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(MacRendererLossError);
      expect((error as Error).message).toBe(
        "renderer lost: window=main WebContent terminated at app-run 2376.9ms (no recovery decision logged); " +
          "before the loss, main progress: last mark app-ready at webview 386.0ms (app-run 1773.4ms), 0 heartbeat(s) after it",
      );
      return true;
    });
    // The reloaded document finishing later must not matter.
    log = [LOST_BEFORE_READY, RELOADED, ...SECOND_BOOT].join("\n");
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a sample whose markers completed when the loss lands during the survival interval", async () => {
    vi.useFakeTimers();
    let log = COMPLETED_THEN_LOST.join("\n");
    const result = waitForMacStartupProcess(new FakeStartupChild(), () => log, options);
    let settled = false;
    const assertion = expect(result.finally(() => { settled = true; })).rejects.toThrow(
      /^renderer lost: window=main WebContent terminated at app-run 2439\.9ms \(decision=reload attempt=1 limit=3 period-s=60\)/,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    log = [...COMPLETED_THEN_LOST, LOST, RELOADED, ...SECOND_BOOT].join("\n");
    await vi.advanceTimersByTimeAsync(30);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks for loss once more when the survival interval ends", async () => {
    vi.useFakeTimers();
    let log = COMPLETED_THEN_LOST.join("\n");
    const result = waitForMacStartupProcess(new FakeStartupChild(), () => log, { ...options, pollMs: 60_000 });
    const assertion = expect(result).rejects.toBeInstanceOf(MacRendererLossError);
    log = [...COMPLETED_THEN_LOST, LOST].join("\n");
    await vi.advanceTimersByTimeAsync(5_001);
    await assertion;
  });

  it("still passes a healthy sample after the survival interval", async () => {
    vi.useFakeTimers();
    const result = waitForMacStartupProcess(new FakeStartupChild(), () => COMPLETED_THEN_LOST.join("\n"), options);
    await vi.advanceTimersByTimeAsync(5_050);
    await expect(result).resolves.toMatchObject({ readinessTotalMs: 2431.2 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** Excerpt of the #936 report: the header line, then the start of the body. */
const IPS = [
  '{"app_name":"com.apple.WebKit.WebContent","timestamp":"2026-09-30 23:46:48.00 +0000","app_version":"21624","build_version":"21624.5.1.11.3","bundleID":"com.apple.WebKit.WebContent","bug_type":"309","os_version":"macOS 26.6.2 (25G83)","name":"com.apple.WebKit.WebContent","incident_id":"02D51BA1-400D-476F-9D8B-CFD59A645743"}',
  "{",
  '  "uptime" : 970,',
  '  "procRole" : "Foreground",',
  '  "captureTime" : "2026-09-30 23:46:48.3717 +0000",',
  '  "pid" : 42633,',
  '  "procName" : "com.apple.WebKit.WebContent",',
  '  "parentPid" : 1,',
  '  "exception" : {"codes":"0x0000000000000001, 0x000000019a8f1c44"', // truncated by the copy bound
].join("\n");

describe("dead page identity", () => {
  it("reads the pid, process and WebKit build from a (truncated) crash report", () => {
    expect(parseCrashReportIdentity(IPS)).toEqual({
      pid: 42633,
      procName: "com.apple.WebKit.WebContent",
      bundleId: "com.apple.WebKit.WebContent",
      buildVersion: "21624.5.1.11.3",
      osVersion: "macOS 26.6.2 (25G83)",
      captureTime: "2026-09-30 23:46:48.3717 +0000",
      bugType: "309",
    });
    expect(parseCrashReportIdentity("GPU Reset")).toBeNull();
    expect(parseCrashReportIdentity("")).toBeNull();
  });

  it("pairs WebContent pids with page IDs from WebKit's unified-log prefixes", () => {
    const log = [
      "2026-09-30 23:46:46.2 Df com.apple.WebKit[42629:1] [com.apple.WebKit:Loading] [pageProxyID=8, webPageID=9, PID=42633] WebPageProxy::didCommitLoadForFrame",
      "2026-09-30 23:46:47.4 Df com.apple.WebKit[42629:1] [com.apple.WebKit:Loading] [pageProxyID=37, webPageID=38, PID=42634] WebPageProxy::didCommitLoadForFrame",
      "2026-09-30 23:46:48.4 E  com.apple.WebKit[42629:1] [com.apple.WebKit:Process] [pageProxyID=8, webPageID=9, PID=42633] WebPageProxy::processDidTerminate: (pid 42633), reason=Crash",
      "2026-09-30 23:46:48.4 Df com.apple.WebKit[42629:1] PID=1 without a page",
    ].join("\n");
    expect(parseWebPageProcesses(log)).toEqual([
      { pid: 42633, webPageIds: [9], terminated: true },
      { pid: 42634, webPageIds: [38], terminated: false },
    ]);
  });

  it("merges both sources and ignores reports from other processes", () => {
    expect(terminatedWebContentProcesses(
      [
        { file: "r/0-com.apple.WebKit.WebContent.ips", text: IPS },
        { file: "r/1-Kernel.gpuRestart", text: "GPU Reset" },
        { file: "r/2-tauri-explorer.ips", text: IPS.replaceAll("com.apple.WebKit.WebContent", "tauri-explorer") },
      ],
      [
        { pid: 42633, webPageIds: [9], terminated: true },
        { pid: 42634, webPageIds: [38], terminated: false },
        { pid: 50000, webPageIds: [12], terminated: true },
      ],
    )).toEqual([
      {
        pid: 42633, sources: ["crash-report", "unified-log"], report: "r/0-com.apple.WebKit.WebContent.ips",
        webPageIds: [9], buildVersion: "21624.5.1.11.3", captureTime: "2026-09-30 23:46:48.3717 +0000",
      },
      { pid: 50000, sources: ["unified-log"], report: null, webPageIds: [12], buildVersion: null, captureTime: null },
    ]);
  });
});

describe("evidence for a renderer loss", () => {
  let root: string;
  let reports: string;
  const SAMPLE_STARTED = 1_000_000;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-loss-"));
    reports = path.join(root, "reports");
    fs.mkdirSync(reports, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("waits for the dead page's crash report instead of profiling survivors", async () => {
    const calls: string[][] = [];
    const run: EvidenceCommandRunner = async (command, args, { outputPath, keep }) => {
      calls.push([command, ...args, `keep=${keep ?? "head"}`]);
      fs.writeFileSync(outputPath, command === "/usr/bin/log"
        ? "[pageProxyID=8, webPageID=9, PID=42633] WebPageProxy::processDidTerminate: reason=Crash\n"
        : "");
      return { exitCode: 0, signal: null, timedOut: false, bytes: 1, truncated: false };
    };
    // ReportCrash writes the report after the qualifier has noticed the loss.
    setTimeout(() => {
      const report = path.join(reports, "com.apple.WebKit.WebContent-2026-09-30-234648.ips");
      fs.writeFileSync(report, IPS);
    }, 60);
    const failure = new MacRendererLossError(findRendererTerminations(LOST_BEFORE_READY), LOST_BEFORE_READY);
    const error = await withStallEvidence(failure, root, () =>
      captureMacStartupStallEvidence({
        pid: 4242,
        binary: "/work/tauri-explorer",
        outputDir: root,
        directoryName: "sample-09-renderer-loss",
        sampleStartedAtMs: SAMPLE_STARTED,
        reason: "renderer-loss",
        run,
        diagnosticReportDirectories: [reports],
        limits: { crashReportWaitMs: 2_000, crashReportPollMs: 10 },
      }),
    );

    expect(calls.map(([command]) => command)).toEqual(["/bin/ps", "/usr/bin/log"]);
    expect(calls[1].at(-1)).toBe("keep=tail");
    expect(error.message.startsWith(failure.message)).toBe(true);
    expect(error.cause).toBe(failure);
    expect(error.message).toContain(
      "renderer-loss evidence in sample-09-renderer-loss: ps captured, log-show captured; 1 new diagnostic report(s); " +
        "terminated WebContent pid(s): 42633 (crash-report+unified-log)",
    );
    const summary = JSON.parse(fs.readFileSync(path.join(root, "sample-09-renderer-loss", "evidence.json"), "utf8"));
    expect(summary).toMatchObject({
      schemaVersion: 2,
      reason: "renderer-loss",
      webContentPids: [],
      terminatedWebContent: [{ pid: 42633, webPageIds: [9], buildVersion: "21624.5.1.11.3" }],
      diagnosticReports: { duringCapture: [] },
    });
  });

  it("gives up on a crash report that never arrives", async () => {
    const run: EvidenceCommandRunner = async (_command, _args, { outputPath }) => {
      fs.writeFileSync(outputPath, "");
      return { exitCode: 0, signal: null, timedOut: false, bytes: 0, truncated: false };
    };
    const began = Date.now();
    const { summary } = await captureMacStartupStallEvidence({
      pid: 4242, binary: "tauri-explorer", outputDir: root, directoryName: "sample-01-renderer-loss",
      sampleStartedAtMs: SAMPLE_STARTED, reason: "renderer-loss", run,
      diagnosticReportDirectories: [reports], limits: { crashReportWaitMs: 100, crashReportPollMs: 10 },
    });
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(summary).toMatchObject({ incomplete: false, terminatedWebContent: [] });
  });
});

describe("unified log capture", () => {
  it("drops WebKit's per-request categories but keeps the rest of WebKit and the app", () => {
    const predicate = unifiedLogPredicate("tauri-explorer");
    expect(predicate).toContain('process == "tauri-explorer"');
    expect(predicate).toContain('subsystem BEGINSWITH "com.apple.WebKit"');
    expect(predicate).toContain('AND NOT (subsystem == "com.apple.WebKit" AND category IN {"Network", "ResourceLoading"})');
  });

  it("keeps the newest output, from a line boundary, without stopping the command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tail-"));
    try {
      const output = path.join(root, "log.txt");
      const result = await runBoundedEvidenceCommand(
        "/bin/sh", ["-c", "i=0; while [ $i -lt 2000 ]; do echo \"line $i\"; i=$((i+1)); done"],
        { timeoutMs: 5_000, maxBytes: 100, outputPath: output, keep: "tail" },
      );
      const kept = fs.readFileSync(output, "utf8");
      expect(result).toMatchObject({ exitCode: 0, truncated: true, timedOut: false, bytes: kept.length });
      expect(kept.length).toBeLessThanOrEqual(100);
      expect(kept.endsWith("line 1999\n")).toBe(true);
      expect(kept.split("\n")[0]).toMatch(/^line \d+$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stall profiling targets", () => {
  it("puts the pages the unified log names before newer renderers", () => {
    const table = [
      "  PID  PPID  PGID STAT     ELAPSED    RSS  %CPU COMMAND",
      "5001     1  5001 S          00:29  60000  99.0 /x/com.apple.WebKit.WebContent",
      "5002     1  5002 S          00:28  50000   0.0 /x/com.apple.WebKit.WebContent",
    ].join("\n");
    expect(selectStallProcesses(table, null, 31, 1).webContentPids).toEqual([5002]);
    expect(selectStallProcesses(table, null, 31, 1, [5001]).webContentPids).toEqual([5001]);
  });
});
