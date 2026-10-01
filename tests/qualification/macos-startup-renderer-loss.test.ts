/**
 * Renderer loss in a macOS startup sample (#942). The fixtures are the
 * retained #936 CI logs (run 36790425556): foreground sample 10 completed
 * every marker and then lost its renderer 8.7 ms later, and was reported as a
 * pass; warm-probe sample 9 lost it before ui-ready and waited out 30 s. A
 * loss is never a measurement: the sample is a recovered loss (recorded and
 * replaced) when the app reloads the main window to a single new readiness,
 * and a failure otherwise.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assessRendererLoss,
  buildMacStartupQualificationReport,
  findRendererTerminations,
  MacRendererLossError,
  MAX_RECOVERED_RENDERER_LOSSES,
  parseAttributedMacStartupLog,
  waitForMacStartupProcess,
  webContentCrashReport,
  type NativeStartupChild,
  type RendererLossRecord,
} from "../../e2e-tauri/native-qualification";
import {
  captureMacStartupStallEvidence,
  withStallEvidence,
  type EvidenceCommandRunner,
} from "../../e2e-tauri/native-qualification/stall-evidence";

const line = (level: string, target: string, message: string) =>
  `[2026-09-30][23:43:15][${level}][${target}] ${message}`;
const SYSTEM = "tauri_explorer_lib::system";
const RELOAD_TARGET = "tauri_explorer_lib::renderer_owner::reload";

/** Foreground sample 10: complete, then the renderer died (reported as PASS). */
const COMPLETED_THEN_LOST = [
  line("INFO", "tauri_explorer_lib", "Startup(native-window): window=main app-run-epoch-ms=1790811793552.789 process-entry-to-run=0.1ms window-built=250.0ms"),
  line("INFO", SYSTEM, "Startup(webview-progress): window=main mark=app-ready webview-ms=407.0 app-run-ms=1816.1"),
  line("INFO", SYSTEM, "Startup(webview): window=main boot-epoch-ms=1790811794961.000 bundle-exec=216.0ms mount=321.0ms commands-ready=333.0ms settings-ready=362.0ms list-ready=406.0ms app-ready=407.0ms ui-ready=1021.0ms total=1021.0ms"),
  line("INFO", SYSTEM, "Startup(native-ready): window=main app-run-to-ready=2431.2ms receipt-epoch-ms=1790811795985.206"),
];
const LOST = line("WARN", "tauri_explorer_lib::renderer_owner",
  "Renderer(web-content-terminated): window=main webview=main epoch-ms=1790811795993.919 app-run-ms=2439.9");
const RELOADED = line("WARN", RELOAD_TARGET,
  "Renderer(recovery): window=main webview=main decision=reload attempt=1 limit=3 period-s=60 document=recorded");
/** What the reloaded document logs on its second boot. */
const SECOND_BOOT = [
  line("INFO", SYSTEM, "Startup(webview): window=main boot-epoch-ms=1790812009000.000 bundle-exec=120.0ms mount=200.0ms commands-ready=210.0ms settings-ready=230.0ms list-ready=260.0ms app-ready=261.0ms ui-ready=300.0ms total=300.0ms"),
  line("INFO", SYSTEM, "Startup(native-ready): window=main app-run-to-ready=3100.0ms receipt-epoch-ms=1790811796501.000"),
];
/** Warm-probe sample 9: lost after app-ready, before ui-ready. */
const LOST_BEFORE_READY = [
  line("INFO", "tauri_explorer_lib", "Startup(native-window): window=main app-run-epoch-ms=1790812005995.797 process-entry-to-run=0.1ms window-built=222.7ms"),
  line("INFO", SYSTEM, "Startup(webview-progress): window=main mark=app-ready webview-ms=386.0 app-run-ms=1773.4"),
  line("WARN", "tauri_explorer_lib", "Renderer(web-content-terminated): window=main webview=main epoch-ms=1790812008372.732 app-run-ms=2376.9"),
];
const WARM_LOST = [
  "Renderer(web-content-terminated): window=explorer-warm-1 webview=explorer-warm-1 epoch-ms=1 app-run-ms=2",
  line("WARN", RELOAD_TARGET, "Renderer(recovery): window=explorer-warm-1 webview=explorer-warm-1 decision=retire-parked"),
];
const recovered = (log: string[]) => [...log, RELOADED, ...SECOND_BOOT];
const join = (lines: string[]) => lines.join("\n");

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
  it("carry the window, the clock, WebKitGTK's reason and that window's own recovery decision", () => {
    const linux = "Renderer(web-content-terminated): window=explorer-1 webview=explorer-1 epoch-ms=1 app-run-ms=812.5 reason=crashed";
    expect(findRendererTerminations(join([linux, ...WARM_LOST, LOST, RELOADED]))).toEqual([
      { window: "explorer-1", appRunMs: 812.5, reason: "crashed", decision: null },
      { window: "explorer-warm-1", appRunMs: 2, reason: null, decision: "retire-parked" },
      { window: "main", appRunMs: 2439.9, reason: null, decision: "reload" },
    ]);
  });

  it("count even when their fields drift from the expected format", () => {
    const [drifted] = findRendererTerminations("x Renderer(web-content-terminated) something changed");
    expect(drifted).toEqual({ window: null, appRunMs: null, reason: null, decision: null });
  });
});

describe("assessing a sample's renderer losses", () => {
  it.each([
    ["the main window reloaded to one new readiness after a completed boot", recovered([...COMPLETED_THEN_LOST, LOST])],
    ["the main window reloaded after losing its first boot", recovered(LOST_BEFORE_READY)],
    ["a parked warm window was retired while main was ready", [...COMPLETED_THEN_LOST, ...WARM_LOST]],
  ])("is recovered when %s", (_case, log) => {
    expect(assessRendererLoss(join(log)).status).toBe("recovered");
  });

  it.each([
    ["no recovery decision is logged yet", [...COMPLETED_THEN_LOST, LOST]],
    ["the reloaded document has not reached readiness", [...COMPLETED_THEN_LOST, LOST, RELOADED, SECOND_BOOT[0]]],
    ["a warm window is retired before main is ready", [COMPLETED_THEN_LOST[0], ...WARM_LOST]],
    ["a warm window's loss has no decision yet, though main is ready", [...COMPLETED_THEN_LOST, WARM_LOST[0]]],
  ])("is pending while %s", (_case, log) => {
    expect(assessRendererLoss(join(log)).status).toBe("pending");
  });

  it.each([
    ["the reload budget is exhausted", "decision=exhausted recent=3 limit=3 period-s=60", "recovery decision=exhausted"],
    ["the reload request fails", "decision=reload-failed error=boom", "recovery decision=reload-failed"],
  ])("fails when %s", (_case, decision, reason) => {
    const log = [...COMPLETED_THEN_LOST, LOST,
      line("WARN", RELOAD_TARGET, `Renderer(recovery): window=main webview=main ${decision}`), ...SECOND_BOOT];
    expect(assessRendererLoss(join(log))).toMatchObject({ status: "failed", reason });
  });

  it("does not take the lost document's late markers for its recovery", () => {
    // CI run 36799110398 sample 9: the dying document's ready IPC was logged
    // 2 ms after the termination line, before the reloaded document booted.
    const [nativeWindow, progress, webview, ready] = COMPLETED_THEN_LOST;
    const inFlight = [nativeWindow, progress, LOST, RELOADED, webview, ready];
    expect(assessRendererLoss(join(inFlight)).status).toBe("pending");
    expect(assessRendererLoss(join([...inFlight, ...SECOND_BOOT])).status).toBe("recovered");
    // Without the loss's clock its documents cannot be told apart.
    const unclocked = join([...inFlight, ...SECOND_BOOT]).replace(/ epoch-ms=\S+/, "");
    expect(assessRendererLoss(unclocked)).toMatchObject({ status: "failed" });
  });

  it("fails when the recovered document's markers cannot be attributed to one boot", () => {
    const unattributable = "the recovered main document's markers cannot be attributed";
    for (const log of [
      recovered([...COMPLETED_THEN_LOST, LOST]).concat(SECOND_BOOT[1]),
      recovered([...COMPLETED_THEN_LOST, LOST]).concat(SECOND_BOOT),
    ]) {
      expect(assessRendererLoss(join(log))).toMatchObject({ status: "failed", reason: unattributable });
    }
  });

  it("is none without a termination line", () => {
    expect(assessRendererLoss(join(COMPLETED_THEN_LOST))).toEqual({ status: "none" });
  });
});

describe("the attributed startup parser", () => {
  it("measured the #936 sample that completed and then lost its renderer, and rejects it once the loss is logged", () => {
    expect(parseAttributedMacStartupLog(join(COMPLETED_THEN_LOST), foreground).readinessTotalMs).toBe(2431.2);
    for (const log of [[...COMPLETED_THEN_LOST, LOST], recovered([...COMPLETED_THEN_LOST, LOST])]) {
      expect(() => parseAttributedMacStartupLog(join(log), foreground)).toThrow(MacRendererLossError);
    }
  });

  it("refuses markers from two main-window documents even without a termination line", () => {
    expect(() => parseAttributedMacStartupLog(join([...COMPLETED_THEN_LOST, ...SECOND_BOOT]), foreground))
      .toThrow("Startup(webview) is recorded by more than one main-window document");
    expect(() => parseAttributedMacStartupLog(join([...COMPLETED_THEN_LOST, SECOND_BOOT[1]]), foreground))
      .toThrow("Startup(native-ready) is recorded by more than one main-window document");
  });
});

describe("waiting for a startup sample", () => {
  const options = { timeoutMs: 30_000, survivalMs: 5_000, pollMs: 25, measureWarm: false };
  const settle = (result: Promise<unknown>) => {
    const state: { error?: unknown; settled: boolean } = { settled: false };
    result.then(() => { state.settled = true; }, (error) => Object.assign(state, { error, settled: true }));
    return state;
  };

  it("records a loss before readiness as recovered once the reloaded window is ready", async () => {
    vi.useFakeTimers();
    let log = LOST_BEFORE_READY;
    const state = settle(waitForMacStartupProcess(new FakeStartupChild(), () => join(log), options));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.settled).toBe(false);
    log = recovered(LOST_BEFORE_READY);
    await vi.advanceTimersByTimeAsync(30);
    expect(state.error).toBeInstanceOf(MacRendererLossError);
    expect((state.error as MacRendererLossError).recovered).toBe(true);
    expect((state.error as Error).message).toBe(
      "renderer lost and recovered: window=main WebContent terminated at app-run 2376.9ms (decision=reload); " +
        "before the loss, main progress: last mark app-ready at webview 386.0ms (app-run 1773.4ms), 0 heartbeat(s) after it",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not measure a sample whose loss lands during the survival interval", async () => {
    vi.useFakeTimers();
    let log = COMPLETED_THEN_LOST;
    const state = settle(waitForMacStartupProcess(new FakeStartupChild(), () => join(log), options));
    await vi.advanceTimersByTimeAsync(1_000);
    log = [...COMPLETED_THEN_LOST, LOST];
    // Past the survival interval: the loss holds the sample until recovery.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.settled).toBe(false);
    log = recovered([...COMPLETED_THEN_LOST, LOST]);
    await vi.advanceTimersByTimeAsync(30);
    expect((state.error as MacRendererLossError).recovered).toBe(true);
  });

  it("checks for loss once more when the survival interval ends", async () => {
    vi.useFakeTimers();
    let log = COMPLETED_THEN_LOST;
    const state = settle(waitForMacStartupProcess(new FakeStartupChild(), () => join(log), { ...options, pollMs: 60_000 }));
    log = recovered([...COMPLETED_THEN_LOST, LOST]);
    await vi.advanceTimersByTimeAsync(5_001);
    expect((state.error as MacRendererLossError).recovered).toBe(true);
  });

  it("fails a loss that does not recover within the sample bound", async () => {
    vi.useFakeTimers();
    const state = settle(waitForMacStartupProcess(
      new FakeStartupChild(), () => join([...LOST_BEFORE_READY, RELOADED]), options));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((state.error as MacRendererLossError).recovered).toBe(false);
    expect((state.error as Error).message).toMatch(/^renderer lost: .*; no recovery within 30000ms; before the loss/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails an exhausted recovery at once", async () => {
    vi.useFakeTimers();
    const exhausted = line("WARN", RELOAD_TARGET, "Renderer(recovery): window=main webview=main decision=exhausted recent=3 limit=3 period-s=60");
    const state = settle(waitForMacStartupProcess(
      new FakeStartupChild(), () => join([...LOST_BEFORE_READY, exhausted]), options));
    await vi.advanceTimersByTimeAsync(30);
    expect((state.error as Error).message).toContain("; recovery decision=exhausted;");
  });

  it("fails with the pending loss, not a bare exit, when the app exits before recovering", async () => {
    vi.useFakeTimers();
    const child = new FakeStartupChild();
    const state = settle(waitForMacStartupProcess(child, () => join([...LOST_BEFORE_READY, RELOADED]), options));
    await vi.advanceTimersByTimeAsync(30);
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
    expect((state.error as MacRendererLossError).recovered).toBe(false);
    expect((state.error as Error).message).toMatch(
      /^renderer lost: window=main .*; application exited \(code 1, signal none\) before the loss recovered; before the loss/);
  });

  it("still passes a healthy sample after the survival interval", async () => {
    vi.useFakeTimers();
    const result = waitForMacStartupProcess(new FakeStartupChild(), () => join(COMPLETED_THEN_LOST), options);
    await vi.advanceTimersByTimeAsync(5_050);
    await expect(result).resolves.toMatchObject({ readinessTotalMs: 2431.2 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the qualification report", () => {
  const loss = (sample: number, isRecovered = true): RendererLossRecord => ({
    sample, recovered: isRecovered, description: `renderer lost in ${sample}`, log: `sample-${sample}.log`, evidence: null,
  });
  const report = (rendererLosses: RendererLossRecord[]) => buildMacStartupQualificationReport({
    build: { commit: "abc", profile: "p", binary: "/b", binarySha256: "d", binaryBytes: 1, binaryModifiedAt: "t" },
    platform: { os: "macos", release: "25.6", arch: "arm64", hardwareModel: "Mac16,1", cpu: "M4", memoryBytes: 1 },
    scenario: {
      id: "macos-foreground-startup", requestedSamples: 1, timeoutMs: 30_000, warmMeasure: false,
      launchMethod: "direct", cachePolicy: "fresh", focus: "requested", visibility: "visible",
      frameCriterion: "raf", inputCriterion: "none",
    },
    startedAt: "s",
    finishedAt: "f",
    samples: [{ ...parseAttributedMacStartupLog(join(COMPLETED_THEN_LOST), foreground), log: "sample-02.log" }],
    artifacts: [],
    errors: [],
    halfBounceDeadlineMs: null,
    rendererLosses,
  });

  it("records recovered losses outside the timing summary and passes within the limit", () => {
    const passed = report([loss(1)]);
    expect(passed).toMatchObject({ passed: true, rendererLosses: [loss(1)], coldStartup: { sampleCount: 1 } });
  });

  it("fails an unrecovered loss, and more recovered losses than the limit", () => {
    expect(report([loss(1, false)])).toMatchObject({ passed: false, errors: ["sample 1: renderer lost in 1"] });
    const losses = (count: number) => Array.from({ length: count }, (_, index) => loss(index + 1));
    expect(report(losses(MAX_RECOVERED_RENDERER_LOSSES)).passed).toBe(true);
    const many = losses(MAX_RECOVERED_RENDERER_LOSSES + 1);
    expect(report(many).errors).toEqual([`renderer lost in 4 recovered samples (limit ${MAX_RECOVERED_RENDERER_LOSSES})`]);
  });
});

/** Excerpt of the #936 report: the header line, then the start of the body. */
const IPS = [
  '{"app_name":"com.apple.WebKit.WebContent","timestamp":"2026-09-30 23:46:48.00 +0000","app_version":"21624","build_version":"21624.5.1.11.3","bundleID":"com.apple.WebKit.WebContent","bug_type":"309","os_version":"macOS 26.6.2 (25G83)","name":"com.apple.WebKit.WebContent","incident_id":"02D51BA1-400D-476F-9D8B-CFD59A645743"}',
  "{",
  '  "captureTime" : "2026-09-30 23:46:48.3717 +0000",',
  '  "pid" : 42633,',
  '  "procName" : "com.apple.WebKit.WebContent",',
  '  "exception" : {"codes":"0x0000000000000001, 0x000000019a8f1c44"', // truncated by the copy bound
].join("\n");

describe("evidence for a renderer loss", () => {
  let root: string;
  let reports: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-loss-"));
    reports = path.join(root, "reports");
    fs.mkdirSync(reports, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("identifies a WebContent crash report by pid and WebKit build", () => {
    expect(webContentCrashReport(IPS)).toEqual({ pid: 42633, buildVersion: "21624.5.1.11.3" });
    expect(webContentCrashReport("GPU Reset")).toBeNull();
  });

  it("waits for the dead page's crash report instead of profiling the survivors", async () => {
    const commands: string[] = [];
    const run: EvidenceCommandRunner = async (command, _args, { outputPath }) => {
      commands.push(command);
      fs.writeFileSync(outputPath, "");
      return { exitCode: 0, signal: null, timedOut: false, bytes: 0, truncated: false };
    };
    // ReportCrash writes the report after the qualifier has noticed the loss.
    setTimeout(() => fs.writeFileSync(path.join(reports, "com.apple.WebKit.WebContent-2026-09-30.ips"), IPS), 60);
    const log = join(recovered(LOST_BEFORE_READY));
    const failure = new MacRendererLossError(findRendererTerminations(log), log, null);
    const error = await withStallEvidence(failure, root, () =>
      captureMacStartupStallEvidence({
        pid: 4242,
        binary: "/work/tauri-explorer",
        outputDir: root,
        directoryName: "sample-09-renderer-loss",
        sampleStartedAtMs: Date.now() - 3_000,
        reason: "renderer-loss",
        run,
        diagnosticReportDirectories: [reports],
        limits: { crashReportWaitMs: 2_000, crashReportPollMs: 10 },
      }),
    );

    expect(commands).toEqual(["/bin/ps", "/usr/bin/log"]);
    expect(error.cause).toBe(failure);
    expect(error.message).toBe(`${failure.message}; renderer-loss evidence in sample-09-renderer-loss: ` +
      "ps captured, log-show captured; 1 new diagnostic report(s); WebContent crash report pid(s): 42633");
    const summary = JSON.parse(fs.readFileSync(path.join(root, "sample-09-renderer-loss", "evidence.json"), "utf8"));
    expect(summary).toMatchObject({
      reason: "renderer-loss",
      webContentPids: [],
      terminatedWebContent: [{ pid: 42633, buildVersion: "21624.5.1.11.3" }],
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
      sampleStartedAtMs: began, reason: "renderer-loss", run,
      diagnosticReportDirectories: [reports], limits: { crashReportWaitMs: 100, crashReportPollMs: 10 },
    });
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(summary).toMatchObject({ incomplete: false, terminatedWebContent: [] });
  });
});
