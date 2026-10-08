/**
 * Slow directory-load diagnostics (#1022): pure trace, record and report logic.
 *
 * A load is an immutable trace of phase spans measured on a monotonic clock
 * (offsets from the trace start). `state/load-watchdog.ts` advances traces and
 * owns the timers; native code (`src-tauri/src/load_diagnostics/`) adds the
 * native phase breakdown and filesystem before persisting a record.
 */

/** A load still pending at this age is recorded while it is stuck. */
export const SLOW_LOAD_THRESHOLD_MS = 5000;
/** Bounds keep a pathological workload from growing a record. */
export const MAX_TRACE_SPANS = 32;
export const MAX_OTHERS_IN_FLIGHT = 5;
/** Report-dialog defaults: records from the last day only (older ones are
 *  unlikely to be the bug being reported), and only a few of them. */
export const REPORTABLE_SLOW_LOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_REPORTED_SLOW_LOADS = 3;
/** Must not exceed the native `MAX_DIAGNOSTICS_UNITS` in `user_report.rs`. */
export const MAX_SLOW_LOAD_REPORT_UNITS = 6000;

/** Frontend phases on the path from navigation to a rendered listing. */
export type FrontendLoadPhase =
  | "auto-enter" // peeking single-child folders before navigating
  | "queued" // waiting behind an earlier listing in the same pane
  | "watch-ready" // directory-event listener + native session acknowledgement
  | "provider" // a plugin filesystem provider's listing
  | "native" // the native listing command round trip
  | "decode" // decoding the compact listing transport
  | "test-hold" // an E2E listing probe holding the result (hook builds only)
  | "publish"; // applying entries, sorting and selecting

export type LoadReason = "navigate" | "history" | "initial" | "parent-fallback";
export type LoadOutcome = "ok" | "error" | "superseded" | "destroyed";

export interface PhaseSpan {
  readonly phase: FrontendLoadPhase;
  readonly startMs: number;
  readonly endMs: number | null;
}

export interface QueuedBehind {
  readonly path: string;
  readonly reason: string;
  /** Monotonic start of the blocking listing. */
  readonly startedMono: number;
  readonly traceId: string | null;
}

export interface LoadTrace {
  readonly id: string;
  /** The folder being listed (after any auto-enter descent). */
  readonly path: string;
  /** The folder the user asked for, when auto-enter descended from it. */
  readonly requestedPath: string | null;
  readonly pane: number | null;
  readonly reason: LoadReason;
  readonly spinnerVisible: boolean;
  readonly startedMono: number;
  readonly startedEpoch: number;
  readonly spans: readonly PhaseSpan[];
  readonly queuedBehind: QueuedBehind | null;
  readonly entries: number | null;
  readonly outcome: LoadOutcome | null;
  readonly finishedMono: number | null;
}

export interface LoadTraceInit {
  readonly id: string;
  readonly path: string;
  readonly pane?: number | null;
  readonly reason: LoadReason;
  readonly spinnerVisible: boolean;
}

export function startLoadTrace(init: LoadTraceInit, nowMono: number, nowEpoch: number): LoadTrace {
  return {
    id: init.id,
    path: init.path,
    requestedPath: null,
    pane: init.pane ?? null,
    reason: init.reason,
    spinnerVisible: init.spinnerVisible,
    startedMono: nowMono,
    startedEpoch: nowEpoch,
    spans: [],
    queuedBehind: null,
    entries: null,
    outcome: null,
    finishedMono: null,
  };
}

const offset = (trace: LoadTrace, nowMono: number) => Math.max(0, nowMono - trace.startedMono);

function closeOpenSpan(spans: readonly PhaseSpan[], at: number): readonly PhaseSpan[] {
  const last = spans.at(-1);
  if (!last || last.endMs !== null) return spans;
  return [...spans.slice(0, -1), { ...last, endMs: Math.max(last.startMs, at) }];
}

/** Close the open phase (if any) and open `phase`. A settled trace is final. */
export function enterPhase(trace: LoadTrace, phase: FrontendLoadPhase, nowMono: number): LoadTrace {
  if (trace.outcome !== null) return trace;
  const at = offset(trace, nowMono);
  const closed = closeOpenSpan(trace.spans, at);
  if (closed.at(-1)?.phase === phase && closed.at(-1)?.endMs === at) {
    // Re-entering the phase that just closed continues it.
    return { ...trace, spans: [...closed.slice(0, -1), { ...closed.at(-1)!, endMs: null }] };
  }
  if (closed.length >= MAX_TRACE_SPANS) return { ...trace, spans: closed };
  return { ...trace, spans: [...closed, { phase, startMs: at, endMs: null }] };
}

/** The load now lists `path` (auto-enter descended to it). */
export function retarget(trace: LoadTrace, path: string): LoadTrace {
  if (trace.outcome !== null || path === trace.path) return trace;
  return { ...trace, path, requestedPath: trace.requestedPath ?? trace.path };
}

export function noteQueuedBehind(trace: LoadTrace, blocker: QueuedBehind | null): LoadTrace {
  return trace.outcome !== null ? trace : { ...trace, queuedBehind: blocker };
}

export function noteEntries(trace: LoadTrace, entries: number): LoadTrace {
  return trace.outcome !== null ? trace : { ...trace, entries: Math.max(0, Math.floor(entries)) };
}

export function finishLoadTrace(trace: LoadTrace, outcome: LoadOutcome, nowMono: number): LoadTrace {
  if (trace.outcome !== null) return trace;
  return {
    ...trace,
    spans: closeOpenSpan(trace.spans, offset(trace, nowMono)),
    outcome,
    finishedMono: Math.max(trace.startedMono, nowMono),
  };
}

export function traceElapsedMs(trace: LoadTrace, nowMono: number): number {
  return Math.max(0, (trace.finishedMono ?? nowMono) - trace.startedMono);
}

export function pendingPhase(trace: LoadTrace): FrontendLoadPhase | null {
  const last = trace.spans.at(-1);
  return last && last.endMs === null ? last.phase : null;
}

/** Inclusive: a load that took exactly the threshold is slow. */
export function isSlowLoad(elapsedMs: number, thresholdMs = SLOW_LOAD_THRESHOLD_MS): boolean {
  return Number.isFinite(elapsedMs) && elapsedMs >= thresholdMs;
}

/**
 * Whether a finishing load writes a record: always when it was already
 * recorded while pending (so the record gains its outcome), otherwise only
 * when it crossed the threshold — e.g. its timer was delayed by a blocked
 * event loop. A load superseded before the threshold is not interesting.
 */
export function recordOnFinish(trace: LoadTrace, alreadyRecorded: boolean, thresholdMs = SLOW_LOAD_THRESHOLD_MS): boolean {
  if (trace.outcome === null) return false;
  return alreadyRecorded || isSlowLoad(traceElapsedMs(trace, trace.finishedMono ?? trace.startedMono), thresholdMs);
}

// ===================
// Records
// ===================

export interface RecordedPhase {
  phase: string;
  startMs: number;
  durationMs: number;
  pending: boolean;
}

export interface OtherLoad {
  path: string;
  pendingPhase: string | null;
  elapsedMs: number;
}

/** The frontend half of a record, as sent to `record_slow_load`. */
export interface FrontendSlowLoadRecord {
  id: string;
  path: string;
  requestedPath: string | null;
  pane: number | null;
  reason: string;
  spinnerVisible: boolean;
  startedAt: number;
  capturedAt: number;
  elapsedMs: number;
  thresholdMs: number;
  /** `cancelled` comes only from native-only records (a dropped command). */
  outcome: "pending" | LoadOutcome | "cancelled";
  pendingPhase: string | null;
  phases: RecordedPhase[];
  queuedBehind: { path: string; reason: string; elapsedMs: number; traceId: string | null } | null;
  entries: number | null;
  driveKind: string | null;
  sinceBootMs: number | null;
  othersInFlight: OtherLoad[];
}

export interface NativePhaseSnapshot {
  phase: string;
  startMs: number;
  durationMs: number;
  pending: boolean;
}

export interface NativeLoadSnapshot {
  path: string;
  elapsedMs: number;
  outcome: "pending" | "ok" | "error" | "cancelled";
  pendingPhase: string | null;
  phases: NativePhaseSnapshot[];
  entriesListed: number;
  entriesStatted: number;
  statFailures: number;
  entriesDone: number;
  statMs: number;
  resolveMs: number;
  symlinks: number;
  gitRepoProbe: boolean;
  stalledEntries: { name: string; elapsedMs: number }[];
  slowestEntry: { name: string; elapsedMs: number } | null;
}

export interface FilesystemInfo {
  fsType: string | null;
  mountPoint: string | null;
  category: "local" | "network" | "network-fuse" | "fuse" | "removable" | "memory" | "unknown";
}

/** A persisted record, as returned by `recent_slow_loads`. */
export interface SlowLoadRecord extends FrontendSlowLoadRecord {
  schema: number;
  source: "frontend" | "native-watchdog";
  native: NativeLoadSnapshot | null;
  blocker: NativeLoadSnapshot | null;
  filesystem: FilesystemInfo | null;
  appVersion: string;
  os: string;
}

export interface RecordContext {
  nowMono: number;
  nowEpoch: number;
  thresholdMs?: number;
  driveKind?: string | null;
  sinceBootMs?: number | null;
  others?: readonly LoadTrace[];
}

const round = (value: number) => Math.round(value);

export function buildFrontendRecord(trace: LoadTrace, context: RecordContext): FrontendSlowLoadRecord {
  const { nowMono } = context;
  const elapsed = traceElapsedMs(trace, nowMono);
  const end = offset(trace, trace.finishedMono ?? nowMono);
  return {
    id: trace.id,
    path: trace.path,
    requestedPath: trace.requestedPath,
    pane: trace.pane,
    reason: trace.reason,
    spinnerVisible: trace.spinnerVisible,
    startedAt: round(trace.startedEpoch),
    capturedAt: round(context.nowEpoch),
    elapsedMs: round(elapsed),
    thresholdMs: context.thresholdMs ?? SLOW_LOAD_THRESHOLD_MS,
    outcome: trace.outcome ?? "pending",
    pendingPhase: pendingPhase(trace),
    phases: trace.spans.map((span) => ({
      phase: span.phase,
      startMs: round(span.startMs),
      durationMs: round(Math.max(0, (span.endMs ?? end) - span.startMs)),
      pending: span.endMs === null,
    })),
    queuedBehind: trace.queuedBehind && {
      path: trace.queuedBehind.path,
      reason: trace.queuedBehind.reason,
      elapsedMs: round(Math.max(0, nowMono - trace.queuedBehind.startedMono)),
      traceId: trace.queuedBehind.traceId,
    },
    entries: trace.entries,
    driveKind: context.driveKind ?? null,
    sinceBootMs: context.sinceBootMs == null ? null : round(context.sinceBootMs),
    othersInFlight: (context.others ?? [])
      .filter((other) => other.id !== trace.id && other.outcome === null)
      .slice(0, MAX_OTHERS_IN_FLIGHT)
      .map((other) => ({
        path: other.path,
        pendingPhase: pendingPhase(other),
        elapsedMs: round(traceElapsedMs(other, nowMono)),
      })),
  };
}

// ===================
// Explanation
// ===================

const PHASE_LABELS: Record<string, string> = {
  "auto-enter": "peeking single-subfolder chains before navigating",
  queued: "waiting behind an earlier listing in the same pane",
  "watch-ready": "waiting for the directory-event channel / native session",
  provider: "plugin filesystem provider listing",
  native: "native listing command",
  decode: "decoding the listing",
  "test-hold": "test probe hold",
  publish: "applying and sorting entries",
  "owner-acquire": "renderer ownership check",
  "resolve-path": "resolving the path spelling",
  "blocking-queue": "waiting for a native worker thread",
  "watch-lock": "waiting for the global file-watcher lock",
  "watch-register": "registering the file watcher",
  "root-metadata": "stat of the folder itself",
  "read-dir": "reading directory entries (readdir)",
  "entry-metadata": "per-entry metadata (stat, symlink targets, git-repo probe)",
  sort: "sorting entries",
  respond: "handing the reply to Tauri",
  serialize: "encoding the reply for the webview",
  "ipc-reply": "waiting on the IPC reply / webview",
};

export function describePhase(phase: string): string {
  return PHASE_LABELS[phase] ?? phase;
}

export interface SlowLoadCulprit {
  /** `native ` prefix for native phases, e.g. `native read-dir`. */
  phase: string;
  label: string;
  durationMs: number;
  pending: boolean;
}

function slowest<T extends { durationMs: number }>(spans: readonly T[]): T | undefined {
  return spans.reduce<T | undefined>((best, span) => (!best || span.durationMs > best.durationMs ? span : best), undefined);
}

/** Mirrors `IPC_GAP_MIN_MS` in `src-tauri/src/load_diagnostics/mod.rs`. */
const IPC_GAP_MIN_MS = 1000;

/**
 * The phase that explains the delay: the pending phase while the load is
 * stuck, else the slowest one. When that is the native command, descend into
 * the native breakdown — unless the native command had already finished and
 * most of the frontend's wait came after it (the reply's transfer and decode
 * in the webview), which is then reported as the IPC reply.
 */
export function diagnoseSlowLoad(record: Pick<SlowLoadRecord, "phases" | "native">): SlowLoadCulprit | null {
  const frontend = record.phases.find((phase) => phase.pending) ?? slowest(record.phases);
  if (frontend?.phase === "native" && record.native && record.native.outcome !== "pending") {
    const commandMs = record.native.elapsedMs;
    const gap = frontend.durationMs - commandMs;
    if (gap >= IPC_GAP_MIN_MS && gap >= commandMs) {
      return {
        phase: "ipc-reply",
        label: `native command finished in ${formatSeconds(commandMs)}; ${describePhase("ipc-reply")}`,
        durationMs: gap,
        pending: frontend.pending,
      };
    }
  }
  const native = record.native
    ? record.native.phases.find((phase) => phase.pending) ?? slowest(record.native.phases)
    : undefined;
  if ((!frontend || frontend.phase === "native") && native) {
    return {
      phase: `native ${native.phase}`,
      label: describePhase(native.phase),
      durationMs: native.durationMs,
      pending: native.pending,
    };
  }
  if (!frontend) return null;
  return { phase: frontend.phase, label: describePhase(frontend.phase), durationMs: frontend.durationMs, pending: frontend.pending };
}

// ===================
// Report formatting
// ===================

export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatPhases(phases: readonly { phase: string; durationMs: number; pending: boolean }[]): string {
  return phases.map((phase) => `${phase.phase} ${formatSeconds(phase.durationMs)}${phase.pending ? " (pending)" : ""}`).join(" · ");
}

function formatNative(native: NativeLoadSnapshot): string[] {
  const lines = [`   native: ${formatPhases(native.phases) || "no phases recorded"}`];
  lines.push(
    `   entries: ${native.entriesListed} listed · ${native.entriesStatted} statted${native.statFailures ? ` (${native.statFailures} failed)` : ""} · ${native.entriesDone} done · stat ${formatSeconds(native.statMs)} · symlink/git probes ${formatSeconds(native.resolveMs)} · ${native.symlinks} symlinks · git probe ${native.gitRepoProbe ? "on" : "off"}`,
  );
  // Counts and timings only: file names stay in the local record and are
  // never part of the public report text.
  if (native.stalledEntries.length > 0) {
    const longest = Math.max(...native.stalledEntries.map((entry) => entry.elapsedMs));
    lines.push(`   stalled entries: ${native.stalledEntries.length} (longest ${formatSeconds(longest)})`);
  }
  if (native.slowestEntry) {
    lines.push(`   slowest single entry: ${formatSeconds(native.slowestEntry.elapsedMs)}`);
  }
  return lines;
}

function formatFilesystem(record: SlowLoadRecord): string | null {
  const fs = record.filesystem;
  const parts = [
    fs?.fsType,
    fs && fs.category !== "local" && fs.category !== "unknown" ? fs.category : null,
    fs?.mountPoint ? `mounted at ${fs.mountPoint}` : null,
    record.driveKind && record.driveKind !== "fixed" ? `${record.driveKind} drive` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `   filesystem: ${parts.join(", ")}` : null;
}

/** One record as compact plain text for a public issue. */
export function formatSlowLoadForReport(record: SlowLoadRecord, index: number): string {
  const culprit = diagnoseSlowLoad(record);
  const status = record.outcome === "pending" ? "still pending when captured" : record.outcome;
  const lines = [
    `${index + 1}. ${record.path}${record.requestedPath ? ` (auto-entered from ${record.requestedPath})` : ""}`,
    `   ${new Date(record.startedAt).toISOString()} · ${formatSeconds(record.elapsedMs)} · ${status} · ${record.reason}${record.source === "native-watchdog" ? " · captured natively" : ""}`,
  ];
  if (culprit) {
    lines.push(`   ${culprit.pending ? "stuck in" : "slowest"}: ${culprit.phase} — ${culprit.label} (${formatSeconds(culprit.durationMs)})`);
  }
  if (record.phases.length > 0) lines.push(`   frontend: ${formatPhases(record.phases)}`);
  if (record.native) lines.push(...formatNative(record.native));
  if (record.queuedBehind) {
    lines.push(`   queued behind: ${record.queuedBehind.reason} of ${record.queuedBehind.path} (${formatSeconds(record.queuedBehind.elapsedMs)})`);
    if (record.blocker?.pendingPhase) lines.push(`   blocker native phase: ${record.blocker.pendingPhase}`);
  }
  const filesystem = formatFilesystem(record);
  if (filesystem) lines.push(filesystem);
  if (record.othersInFlight.length > 0) {
    lines.push(`   other loads in flight: ${record.othersInFlight.map((other) => `${other.path} (${other.pendingPhase ?? "?"}, ${formatSeconds(other.elapsedMs)})`).join("; ")}`);
  }
  return lines.join("\n");
}

const units = (value: string) => value.length; // UTF-16 code units, as the relay counts

/**
 * Format as many whole records as fit `maxUnits`, newest first, and say how
 * many were included. A first record larger than the budget is cut at a
 * line boundary; a first line larger than the budget is itself shortened.
 */
export function fitSlowLoadsForReport(
  records: readonly SlowLoadRecord[],
  maxUnits = MAX_SLOW_LOAD_REPORT_UNITS,
): { text: string; included: number } {
  const blocks: string[] = [];
  let used = 0;
  for (const [index, record] of records.entries()) {
    const block = formatSlowLoadForReport(record, index);
    const separator = blocks.length > 0 ? 2 : 0;
    if (used + separator + units(block) <= maxUnits) {
      blocks.push(block);
      used += separator + units(block);
      continue;
    }
    if (blocks.length === 0) {
      const kept: string[] = [];
      for (const line of block.split("\n")) {
        if (units([...kept, line].join("\n")) > maxUnits) break;
        kept.push(line);
      }
      if (kept.length === 0 && maxUnits > 1) {
        // Never split a surrogate pair at the cut.
        kept.push(`${block.slice(0, maxUnits - 1).replace(/[\uD800-\uDBFF]$/, "")}…`);
      }
      if (kept.length > 0) blocks.push(kept.join("\n"));
    }
    break;
  }
  return { text: blocks.join("\n\n"), included: blocks.length };
}

export function formatSlowLoadsForReport(records: readonly SlowLoadRecord[], maxUnits = MAX_SLOW_LOAD_REPORT_UNITS): string {
  return fitSlowLoadsForReport(records, maxUnits).text;
}

/** The relay's body ceiling (`maxRelayBodyUnits` in the relay contract). */
export const MAX_RELAY_BODY_UNITS = 8500;
/** Conservative allowance for the contact line, environment block and the
 *  collapsed-section wrapper that `user_report.rs` adds around diagnostics. */
const REPORT_BODY_OVERHEAD_UNITS = 600;

/**
 * Units left for diagnostics after the reporter's own text, so the preview
 * shows exactly what the native side will send (it would otherwise truncate).
 */
export function slowLoadReportBudget(description: string, contact = ""): number {
  const left = MAX_RELAY_BODY_UNITS - REPORT_BODY_OVERHEAD_UNITS - description.trim().length - contact.trim().length;
  return Math.max(0, Math.min(MAX_SLOW_LOAD_REPORT_UNITS, left));
}

/** Newest-first records captured within `maxAgeMs`, at most `limit`. */
export function selectReportableSlowLoads(
  records: readonly SlowLoadRecord[],
  nowEpoch: number,
  options: { maxAgeMs?: number; limit?: number } = {},
): SlowLoadRecord[] {
  const maxAge = options.maxAgeMs ?? REPORTABLE_SLOW_LOAD_MAX_AGE_MS;
  const limit = options.limit ?? MAX_REPORTED_SLOW_LOADS;
  return records
    .filter((record) => Number.isFinite(record.capturedAt) && nowEpoch - record.capturedAt <= maxAge)
    .sort((a, b) => b.capturedAt - a.capturedAt)
    .slice(0, Math.max(0, limit));
}

// ===================
// Identity
// ===================

/** `<13-digit epoch ms>-<base36 suffix>`: chronological and file-name safe.
 *  Mirrors `valid_trace_id` in `src-tauri/src/load_diagnostics/trace.rs`. */
export function formatTraceId(epochMs: number, suffix: string): string {
  const whole = Number.isFinite(epochMs) ? Math.max(0, Math.floor(epochMs)) : 0;
  const millis = String(whole).padStart(13, "0").slice(-13);
  const clean = suffix.toLowerCase().replace(/[^0-9a-z]/g, "").slice(0, 16) || "0";
  return `${millis}-${clean}`;
}

export function isValidTraceId(id: string): boolean {
  return /^\d{13}-[0-9a-z]{1,16}$/.test(id);
}
