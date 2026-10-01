/**
 * Bounded macOS evidence for a startup sample that timed out (#936) or lost
 * its renderer (#942).
 *
 * A stalled sample's only artifact used to be its stdout log, which cannot say
 * whether the main WKWebView's WebContent process died, hung, or was merely
 * waiting on an IPC response. Before the qualifier stops the application, this
 * records what the operating system can still show about it:
 *
 * - `processes.txt`: the application, its children and every `com.apple.WebKit.*`
 *   process (WebKit's XPC services are launchd children, not app children);
 * - the most recent part of the last 60 s of the unified log for WebKit and the
 *   application, without WebKit's per-request `Network`/`ResourceLoading` noise
 *   (half of all lines in #936, which pushed the crash past the size cap);
 * - for a stall, a 3 s `sample` of the application and of each WebContent
 *   process started during the sample, pages named in the unified log first,
 *   falling back to non-interactive `sudo spindump` when `sample` cannot
 *   inspect a platform binary;
 * - crash, hang and jetsam reports written since the sample started (for a
 *   renderer loss, after waiting a bounded time for the crash report);
 * - the pids of WebContent processes that terminated, from their crash
 *   reports and the unified log, since a dead page cannot be sampled.
 *
 * Every capture has its own time and size bound, the whole collection has an
 * overall deadline, and nothing here throws: a failed capture is recorded in
 * `evidence.json`, never allowed to replace the original failure (ADR 0021; the
 * same rule as `e2e-tauri/diagnostics/process-timeline.ts`).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveQualificationArtifactPath } from "./artifacts";
import { parseCrashReportIdentity, parseWebPageProcesses, type WebPageProcess } from "./renderer-loss";

export interface EvidenceCommandResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Bytes written to the output file (stdout and stderr combined). */
  bytes: number;
  truncated: boolean;
  error?: string;
}

export type EvidenceCommandRunner = (
  command: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    maxBytes: number;
    outputPath: string;
    /**
     * Which end of oversized output to keep. `head` (default) stops the
     * command at the cap; `tail` lets it finish and keeps the newest bytes,
     * which for `log show` are the ones nearest the failure.
     */
    keep?: "head" | "tail";
  },
) => Promise<EvidenceCommandResult>;

export type EvidenceReason = "stall" | "renderer-loss";

export interface TerminatedWebContent {
  pid: number;
  /** Where the termination was found; a crash report is authoritative. */
  sources: Array<"crash-report" | "unified-log">;
  /** Artifact-relative copy of its crash report. */
  report: string | null;
  webPageIds: number[];
  buildVersion: string | null;
  captureTime: string | null;
}

export interface EvidenceCaptureRecord {
  id: string;
  command: string[];
  /** Artifact-relative path of the captured output, when anything was written. */
  file: string | null;
  status: "captured" | "failed";
  durationMs: number;
  bytes: number;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error?: string;
}

export interface StallEvidenceSummary {
  schemaVersion: 2;
  reason: EvidenceReason;
  pid: number | null;
  sampleStartedAt: string;
  capturedAt: string;
  durationMs: number;
  /** True if the overall deadline expired before every capture finished. */
  incomplete: boolean;
  /** WebContent processes profiled (stall only), log-identified pages first. */
  webContentPids: number[];
  /** WebContent pids paired with page IDs in the unified log. */
  webPages: WebPageProcess[];
  terminatedWebContent: TerminatedWebContent[];
  captures: EvidenceCaptureRecord[];
  diagnosticReports: {
    copied: string[];
    /**
     * Copied reports that appeared only while the profiles ran. `sample`
     * suspends its target, and on CI's paravirtualized GPU that can itself
     * trigger a WebContent GPU reset report, so these may be capture artifacts
     * rather than evidence of the stall.
     */
    duringCapture: string[];
    omitted: number;
    /** Reports beyond the copy limit that also appeared during the capture. */
    omittedDuringCapture: number;
    errors: string[];
  };
  errors: string[];
}

export interface StallEvidenceResult {
  /** Absolute evidence directory inside the qualification output directory. */
  directory: string;
  summary: StallEvidenceSummary;
}

export type StallEvidenceLimits = Record<
  | "psTimeoutMs" | "psMaxBytes" | "sampleSeconds" | "sampleTimeoutMs" | "spindumpTimeoutMs"
  | "sampleMaxBytes" | "maxWebContentProcesses" | "logTimeoutMs" | "logMaxBytes"
  | "maxDiagnosticReports" | "diagnosticReportMaxBytes" | "overallTimeoutMs"
  | "crashReportWaitMs" | "crashReportPollMs",
  number
>;

export const STALL_EVIDENCE_LIMITS: Readonly<StallEvidenceLimits> = {
  psTimeoutMs: 10_000,
  psMaxBytes: 1024 * 1024,
  sampleSeconds: 3,
  sampleTimeoutMs: 20_000,
  spindumpTimeoutMs: 40_000,
  sampleMaxBytes: 2 * 1024 * 1024,
  maxWebContentProcesses: 3,
  logTimeoutMs: 60_000,
  logMaxBytes: 4 * 1024 * 1024,
  maxDiagnosticReports: 5,
  diagnosticReportMaxBytes: 1024 * 1024,
  overallTimeoutMs: 90_000,
  // ReportCrash writes the `.ips` after the process is gone; in #936 it landed
  // within a second, so this only bounds a slow or absent report.
  crashReportWaitMs: 15_000,
  crashReportPollMs: 250,
};

/** Spawn a bounded command whose combined output streams into one file. Never rejects. */
export const runBoundedEvidenceCommand: EvidenceCommandRunner = (
  command,
  args,
  { timeoutMs, maxBytes, outputPath, keep = "head" },
) =>
  new Promise((resolve) => {
    let bytes = 0;
    let truncated = false;
    // Tail mode holds at most `maxBytes` (plus one chunk) and writes on exit.
    const tail: Buffer[] = [];
    let tailBytes = 0;
    let timedOut = false;
    let settled = false;
    let error: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let guard: ReturnType<typeof setTimeout> | undefined;
    let output: fs.WriteStream;
    try {
      output = fs.createWriteStream(outputPath);
    } catch (reason) {
      resolve({ exitCode: null, signal: null, timedOut, bytes, truncated, error: String(reason) });
      return;
    }
    output.on("error", (reason) => {
      error ??= `output: ${reason.message}`;
    });
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(guard);
      if (keep === "tail") {
        let kept = Buffer.concat(tail);
        // Start the kept tail on a whole line rather than mid-record.
        const newline = truncated ? kept.indexOf(0x0a) : -1;
        if (newline >= 0) kept = kept.subarray(newline + 1);
        bytes = kept.length;
        output.write(kept);
      }
      output.end(() =>
        resolve({ exitCode, signal, timedOut, bytes, truncated, ...(error ? { error } : {}) }),
      );
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group, so a kill also reaches any descendants that
      // inherited the output pipes and would otherwise keep them open.
      child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (reason) {
      error = String(reason);
      finish(null, null);
      return;
    }
    let killed = false;
    const kill = (): void => {
      killed = true;
      try {
        if (child.pid === undefined) throw new Error("no pid");
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const append = (chunk: Buffer): void => {
      if (keep === "tail") {
        tail.push(chunk);
        tailBytes += chunk.length;
        while (tailBytes > maxBytes && tail.length > 0) {
          const excess = tailBytes - maxBytes;
          truncated = true;
          if (tail[0].length <= excess) {
            tailBytes -= tail.shift()!.length;
          } else {
            tail[0] = tail[0].subarray(excess);
            tailBytes -= excess;
          }
        }
        return;
      }
      if (truncated) return;
      const room = Math.max(0, maxBytes - bytes);
      if (chunk.length > room) {
        output.write(chunk.subarray(0, room));
        bytes += room;
        truncated = true;
        kill();
        return;
      }
      output.write(chunk);
      bytes += chunk.length;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (reason) => {
      error ??= reason.message;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    // After a deliberate kill, stop waiting on the pipes: output past the cap
    // or the deadline is not wanted.
    child.on("exit", (code, signal) => {
      if (!killed) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(code, signal);
    });
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // A killed child normally closes at once; never wait on it indefinitely.
    guard = setTimeout(() => {
      error ??= "command did not close after SIGKILL";
      finish(null, null);
    }, timeoutMs + 5_000);
  });

interface ProcessRow {
  pid: number;
  ppid: number;
  elapsedSeconds: number | null;
  command: string;
  line: string;
}

/** `ps` elapsed time: `[[dd-]hh:]mm:ss`. */
export function parseElapsedSeconds(value: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

function parseProcessTable(text: string): { header: string | null; rows: ProcessRow[] } {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const header = lines[0]?.trim().startsWith("PID") ? lines.shift()! : null;
  const rows: ProcessRow[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    const pid = Number(fields[0]);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    rows.push({
      pid,
      ppid,
      elapsedSeconds: parseElapsedSeconds(fields[4]),
      command: fields.slice(7).join(" "),
      line,
    });
  }
  return { header, rows };
}

/**
 * Keep the application, its direct children and WebKit's processes; pick the
 * WebContent processes started during this sample, newest first. WebContent
 * processes are launchd children, so start time is the only local link to the
 * sample; the qualifier runs one application at a time. Pages the unified log
 * names (`preferred`) go first, so the bound never drops the stalled page in
 * favour of a newer, idle one.
 */
export function selectStallProcesses(
  psOutput: string,
  pid: number | null,
  sampleAgeSeconds: number,
  maxWebContent: number,
  preferred: readonly number[] = [],
): { lines: string[]; webContentPids: number[] } {
  const { header, rows } = parseProcessTable(psOutput);
  const relevant = rows.filter(
    (row) =>
      (pid !== null && (row.pid === pid || row.ppid === pid)) ||
      row.command.includes("com.apple.WebKit."),
  );
  const webContentPids = relevant
    .filter(
      (row) =>
        row.command.includes("com.apple.WebKit.WebContent") &&
        row.elapsedSeconds !== null &&
        row.elapsedSeconds <= sampleAgeSeconds + 5,
    )
    .sort((a, b) =>
      Number(preferred.includes(b.pid)) - Number(preferred.includes(a.pid)) ||
      (a.elapsedSeconds ?? 0) - (b.elapsedSeconds ?? 0))
    .slice(0, maxWebContent)
    .map((row) => row.pid);
  return {
    lines: [...(header ? [header] : []), ...relevant.map((row) => row.line)],
    webContentPids,
  };
}

function truncateFile(file: string, maxBytes: number): boolean {
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
    fs.truncateSync(file, maxBytes);
    return true;
  } catch {
    return false;
  }
}

function fileSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

/** Crash, hang and jetsam reports written since the sample began. */
function newDiagnosticReports(directories: readonly string[], sinceMs: number): string[] {
  const found: { file: string; mtimeMs: number }[] = [];
  const visit = (directory: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 1) visit(file, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const { mtimeMs } = fs.statSync(file);
        if (mtimeMs >= sinceMs) found.push({ file, mtimeMs });
      } catch {
        // A report removed mid-scan is simply absent.
      }
    }
  };
  directories.forEach((directory) => visit(directory, 0));
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map(({ file }) => file);
}

export const defaultDiagnosticReportDirectories = (): string[] => [
  path.join(os.homedir(), "Library", "Logs", "DiagnosticReports"),
  "/Library/Logs/DiagnosticReports",
];

/** Unified-log predicate: WebKit and the app, without per-request noise. */
export function unifiedLogPredicate(processName: string): string {
  return (
    '(process BEGINSWITH "com.apple.WebKit" OR subsystem BEGINSWITH "com.apple.WebKit" ' +
    `OR process == ${JSON.stringify(processName)}) ` +
    'AND NOT (subsystem == "com.apple.WebKit" AND category IN {"Network", "ResourceLoading"})'
  );
}

const isWebContentReport = (file: string): boolean =>
  path.basename(file).includes("com.apple.WebKit.WebContent");

/**
 * Terminated WebContent processes, merged by pid: crash reports are
 * authoritative, unified-log page lines add the page IDs and catch a loss
 * whose report never arrived.
 */
export function terminatedWebContentProcesses(
  reports: ReadonlyArray<{ file: string; text: string }>,
  pages: readonly WebPageProcess[],
): TerminatedWebContent[] {
  const byPid = new Map<number, TerminatedWebContent>();
  const entry = (pid: number): TerminatedWebContent => {
    const existing = byPid.get(pid) ?? {
      pid, sources: [], report: null, webPageIds: [], buildVersion: null, captureTime: null,
    };
    byPid.set(pid, existing);
    return existing;
  };
  for (const { file, text } of reports) {
    const identity = parseCrashReportIdentity(text);
    const webContent = [identity?.procName, identity?.bundleId]
      .some((name) => name?.includes("com.apple.WebKit.WebContent"));
    if (!identity || identity.pid === null || !webContent) continue;
    const terminated = entry(identity.pid);
    if (!terminated.sources.includes("crash-report")) terminated.sources.push("crash-report");
    terminated.report ??= file;
    terminated.buildVersion ??= identity.buildVersion;
    terminated.captureTime ??= identity.captureTime;
  }
  for (const page of pages) {
    const known = byPid.get(page.pid);
    if (!page.terminated && !known) continue;
    const terminated = entry(page.pid);
    if (page.terminated && !terminated.sources.includes("unified-log")) terminated.sources.push("unified-log");
    terminated.webPageIds = [...new Set([...terminated.webPageIds, ...page.webPageIds])].sort((a, b) => a - b);
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function captureMacStartupStallEvidence(options: {
  pid: number | null | undefined;
  binary: string;
  outputDir: string;
  directoryName: string;
  sampleStartedAtMs: number;
  /** A stall profiles live processes; a renderer loss waits for the crash report instead. */
  reason?: EvidenceReason;
  run?: EvidenceCommandRunner;
  now?: () => number;
  diagnosticReportDirectories?: readonly string[];
  limits?: Partial<StallEvidenceLimits>;
}): Promise<StallEvidenceResult> {
  const limits = { ...STALL_EVIDENCE_LIMITS, ...options.limits };
  const run = options.run ?? runBoundedEvidenceCommand;
  const now = options.now ?? Date.now;
  const reason = options.reason ?? "stall";
  const started = now();
  const pid = options.pid ?? null;
  const directory = resolveQualificationArtifactPath(options.outputDir, options.directoryName);
  const summary: StallEvidenceSummary = {
    schemaVersion: 2,
    reason,
    pid,
    sampleStartedAt: new Date(options.sampleStartedAtMs).toISOString(),
    capturedAt: new Date(started).toISOString(),
    durationMs: 0,
    incomplete: false,
    webContentPids: [],
    webPages: [],
    terminatedWebContent: [],
    captures: [],
    diagnosticReports: { copied: [], duringCapture: [], omitted: 0, omittedDuringCapture: 0, errors: [] },
    errors: [],
  };
  const relative = (file: string): string => path.relative(options.outputDir, file);

  const capture = async (
    id: string,
    command: string,
    args: string[],
    bounds: {
      timeoutMs: number;
      maxBytes: number;
      outputPath: string;
      reportPath?: string;
      keep?: "head" | "tail";
    },
  ): Promise<EvidenceCaptureRecord> => {
    const began = now();
    let result: EvidenceCommandResult;
    try {
      result = await run(command, args, bounds);
    } catch (reason) {
      result = { exitCode: null, signal: null, timedOut: false, bytes: 0, truncated: false, error: String(reason) };
    }
    const reportTruncated = bounds.reportPath ? truncateFile(bounds.reportPath, bounds.maxBytes) : false;
    const reportBytes = bounds.reportPath ? fileSize(bounds.reportPath) : null;
    const outputFile = bounds.reportPath && reportBytes ? bounds.reportPath : bounds.outputPath;
    const bytes = reportBytes ?? result.bytes;
    // Hitting a head cap kills the command by design; what it wrote is kept.
    const succeeded =
      (result.exitCode === 0 || (result.truncated && bounds.keep !== "tail")) &&
      !result.timedOut &&
      !result.error &&
      (!bounds.reportPath || (reportBytes ?? 0) > 0);
    const record: EvidenceCaptureRecord = {
      id,
      command: [command, ...args],
      file: bytes > 0 || fileSize(outputFile) ? relative(outputFile) : null,
      status: succeeded ? "captured" : "failed",
      durationMs: now() - began,
      bytes,
      truncated: result.truncated || reportTruncated,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      ...(result.error ? { error: result.error } : {}),
    };
    summary.captures.push(record);
    return record;
  };

  const profile = async (role: string, target: number): Promise<void> => {
    const samplePath = path.join(directory, `sample-${role}-${target}.txt`);
    const sampled = await capture(
      `sample:${role}:${target}`,
      "/usr/bin/sample",
      [String(target), String(limits.sampleSeconds), "-file", samplePath],
      { timeoutMs: limits.sampleTimeoutMs, maxBytes: limits.sampleMaxBytes, outputPath: `${samplePath}.log`, reportPath: samplePath },
    );
    if (sampled.status === "captured") return;
    // Apple platform binaries (WebContent) refuse task_for_pid to `sample`;
    // spindump reads kernel stackshots instead. `-n` never prompts.
    const spindumpPath = path.join(directory, `spindump-${role}-${target}.txt`);
    await capture(
      `spindump:${role}:${target}`,
      "/usr/bin/sudo",
      ["-n", "/usr/sbin/spindump", String(target), String(limits.sampleSeconds), "-file", spindumpPath],
      { timeoutMs: limits.spindumpTimeoutMs, maxBytes: limits.sampleMaxBytes, outputPath: `${spindumpPath}.log`, reportPath: spindumpPath },
    );
  };

  const collect = async (): Promise<void> => {
    fs.mkdirSync(directory, { recursive: true });
    const sampleAgeSeconds = Math.max(0, (started - options.sampleStartedAtMs) / 1000);

    const fullTable = path.join(directory, "ps-full.txt.tmp");
    await capture(
      "ps",
      "/bin/ps",
      ["-axww", "-o", "pid,ppid,pgid,stat,etime,rss,%cpu,command"],
      { timeoutMs: limits.psTimeoutMs, maxBytes: limits.psMaxBytes, outputPath: fullTable },
    );
    let psOutput = "";
    try {
      psOutput = fs.readFileSync(fullTable, "utf8");
    } catch (reason) {
      summary.errors.push(`ps output unreadable: ${String(reason)}`);
    }
    fs.rmSync(fullTable, { force: true });

    // The log comes first: its page lines name the pids worth profiling.
    const logPath = path.join(directory, "unified-log.txt");
    await capture(
      "log-show",
      "/usr/bin/log",
      ["show", "--last", "60s", "--info", "--style", "compact", "--predicate",
        unifiedLogPredicate(path.basename(options.binary))],
      { timeoutMs: limits.logTimeoutMs, maxBytes: limits.logMaxBytes, outputPath: logPath, keep: "tail" },
    );
    try {
      summary.webPages = parseWebPageProcesses(fs.readFileSync(logPath, "utf8"));
    } catch {
      // A missing log is already recorded as a failed capture.
    }
    const livePages = summary.webPages.filter((page) => !page.terminated).map((page) => page.pid);
    const selected = selectStallProcesses(psOutput, pid, sampleAgeSeconds, limits.maxWebContentProcesses, livePages);
    const processes = path.join(directory, "processes.txt");
    fs.writeFileSync(processes, `${selected.lines.join("\n")}\n`);
    const psRecord = summary.captures.find((record) => record.id === "ps");
    if (psRecord) {
      psRecord.file = relative(processes);
      psRecord.bytes = fileSize(processes) ?? 0;
    }

    const reportDirectories =
      options.diagnosticReportDirectories ?? defaultDiagnosticReportDirectories();
    const reportsSince = options.sampleStartedAtMs - 1_000;
    const reportsBeforeCapture = new Set(newDiagnosticReports(reportDirectories, reportsSince));
    const profiled = reason === "stall";
    if (profiled) {
      // A renderer that died cannot be profiled; a hung one can.
      summary.webContentPids = selected.webContentPids;
      await Promise.all([
        ...(pid !== null ? [profile("app", pid)] : []),
        ...selected.webContentPids.map((target) => profile("webcontent", target)),
      ]);
    } else {
      // ReportCrash writes the dead process's report shortly after it exits.
      for (let waited = 0; waited < limits.crashReportWaitMs; waited += limits.crashReportPollMs) {
        if (newDiagnosticReports(reportDirectories, reportsSince).some(isWebContentReport)) break;
        await sleep(limits.crashReportPollMs);
      }
    }

    const reports = newDiagnosticReports(reportDirectories, reportsSince);
    const reportDirectory = path.join(directory, "diagnostic-reports");
    const copiedReports: Array<{ file: string; text: string }> = [];
    for (const [index, report] of reports.entries()) {
      // Reports written while profiles ran may be induced by them (#936).
      const induced = profiled && !reportsBeforeCapture.has(report);
      if (index >= limits.maxDiagnosticReports) {
        summary.diagnosticReports.omitted += 1;
        if (induced) summary.diagnosticReports.omittedDuringCapture += 1;
        continue;
      }
      try {
        fs.mkdirSync(reportDirectory, { recursive: true });
        const destination = path.join(reportDirectory, `${index}-${path.basename(report)}`);
        const source = fs.openSync(report, "r");
        let copied: Buffer;
        try {
          const buffer = Buffer.alloc(limits.diagnosticReportMaxBytes);
          const length = fs.readSync(source, buffer, 0, buffer.length, 0);
          copied = buffer.subarray(0, length);
          fs.writeFileSync(destination, copied);
        } finally {
          fs.closeSync(source);
        }
        summary.diagnosticReports.copied.push(relative(destination));
        copiedReports.push({ file: relative(destination), text: copied.toString("utf8") });
        if (induced) summary.diagnosticReports.duringCapture.push(relative(destination));
      } catch (reason) {
        summary.diagnosticReports.errors.push(`${report}: ${String(reason)}`);
      }
    }
    summary.terminatedWebContent = terminatedWebContentProcesses(copiedReports, summary.webPages);
  };

  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    deadline = setTimeout(() => resolve("expired"), limits.overallTimeoutMs);
    deadline.unref?.();
  });
  try {
    const outcome = await Promise.race([
      collect().then(
        () => "done" as const,
        (reason: unknown) => {
          summary.errors.push(`evidence collection failed: ${String(reason)}`);
          return "done" as const;
        },
      ),
      expired,
    ]);
    summary.incomplete = outcome === "expired";
  } finally {
    clearTimeout(deadline);
  }
  summary.durationMs = now() - started;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "evidence.json"), `${JSON.stringify(summary, null, 2)}\n`);
  } catch (reason) {
    summary.errors.push(`evidence summary unwritable: ${String(reason)}`);
  }
  return { directory, summary };
}

/**
 * Attach captured evidence to a sample failure (a timeout or renderer loss).
 * The failure's own message always leads, and a capture that throws adds a
 * clause instead of replacing it, so evidence collection can never hide why
 * the sample failed.
 */
export async function withStallEvidence(
  failure: Error,
  outputDir: string,
  capture: () => Promise<StallEvidenceResult>,
): Promise<Error> {
  let evidence: string;
  try {
    evidence = describeStallEvidence(await capture(), outputDir);
  } catch (error) {
    evidence = `evidence capture failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return new Error(`${failure.message}; ${evidence}`, { cause: failure });
}

/** One clause for the failure message; the details live in `evidence.json`. */
export function describeStallEvidence(result: StallEvidenceResult, outputDir: string): string {
  const { summary } = result;
  const captures = summary.captures
    .map((record) => `${record.id} ${record.status}${record.truncated ? " (truncated)" : ""}`)
    .join(", ");
  const { copied, omitted, duringCapture, omittedDuringCapture } = summary.diagnosticReports;
  const reports = copied.length + omitted;
  const induced = duringCapture.length + omittedDuringCapture;
  const terminated = summary.terminatedWebContent
    .map(({ pid, sources }) => `${pid} (${sources.join("+")})`)
    .join(", ");
  return (
    `${summary.reason} evidence in ${path.relative(outputDir, result.directory) || "."}: ${captures || "no captures"}` +
    `; ${reports} new diagnostic report(s)` +
    `${induced > 0 ? ` (${induced} written during capture)` : ""}` +
    `${terminated ? `; terminated WebContent pid(s): ${terminated}` : ""}` +
    `${summary.incomplete ? "; incomplete (overall deadline)" : ""}` +
    `${summary.errors.length > 0 ? `; errors: ${summary.errors.join("; ")}` : ""}`
  );
}
