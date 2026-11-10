/** Native recovery records are capabilities by ID, never renderer-owned paths.
 *  `release` forgets a move that nothing else can resolve (a stopped discard,
 *  or a restoration its edited destination stranded, #795): it removes only
 *  the record and its locks, never a file. */
export type FileRecoveryChoice = "restore" | "discard" | "release";

/** Canonical SQLite counters cross IPC as decimal strings, without rounding. */
export function isRecoveryCounter(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,18})$/.test(value)
    && (value.length < 19 || value <= "9223372036854775807");
}

export function compareRecoveryCounters(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

export interface FileRecoveryItem {
  id: string;
  generation: string;
  originalPath: string;
  /** The first of `retainedPaths`; older ports send only this. */
  retainedPath: string | null;
  /** Every folder the record may still hold files in. A cross-volume move
   *  keeps one beside each endpoint, and a stopped discard lists only the
   *  folders it has not removed. Optional: absent from older ports. */
  retainedPaths?: string[];
  /** Measured size of the retained artifact; null when it is not measured. */
  retainedBytes: string | null;
  status: "pending" | "busy" | "ready" | "attention" | "retained";
  message: string;
  actions: FileRecoveryChoice[];
}

/** Native retention accounting (ADR 0023). Byte counters are decimal strings. */
export interface FileRecoveryStorage {
  usedBytes: string;
  budgetBytes: string;
  records: number;
  recordBudget: number;
  unmeasured: number;
  unavailable: number;
  discardable: number;
  atCapacity: boolean;
}

export const emptyRecoveryStorage = (): FileRecoveryStorage => ({
  usedBytes: "0", budgetBytes: "0", records: 0, recordBudget: 0,
  unmeasured: 0, unavailable: 0, discardable: 0, atCapacity: false,
});

export interface FileRecoverySnapshot {
  revision: string;
  items: FileRecoveryItem[];
  storage: FileRecoveryStorage;
  error: string | null;
}

/** A subscription owns discovery; inspect is the explicit filesystem probe. */
export interface FileRecoveryPort {
  subscribe(receive: (snapshot: FileRecoverySnapshot) => void): Promise<() => Promise<void>>;
  list(): Promise<FileRecoverySnapshot>;
  inspect(id: string): Promise<FileRecoverySnapshot>;
  resolve(id: string, generation: string, choice: FileRecoveryChoice): Promise<FileRecoverySnapshot>;
  /** One bounded retention enforcement pass. Never runs at startup. */
  /// Optional: a port that predates retention accounting, or a restricted
  /// source, simply cannot reclaim. Callers must guard rather than assume.
  retireEligible?(): Promise<FileRecoverySnapshot>;
}

export interface RecoveryConfirmation {
  title: string;
  body: string;
  confirm: string;
}

/** Every folder a record may still hold files in, in native order. */
export function retainedFolders(item: Pick<FileRecoveryItem, "retainedPath" | "retainedPaths">): string[] {
  return [...new Set(item.retainedPaths ?? (item.retainedPath ? [item.retainedPath] : []))];
}

function listFolders(folders: string[]): string {
  return folders.length > 1
    ? `${folders.slice(0, -1).join(", ")} and ${folders[folders.length - 1]}`
    : folders[0];
}

/** Irreversible choices are confirmed with copy stating exactly what is lost
 *  and what is kept. Restoring loses nothing, so it needs none. A discard never
 *  touches a public endpoint, so a destination edited after a move survives
 *  it (#795). */
export function recoveryConfirmation(
  choice: FileRecoveryChoice,
  item: Pick<FileRecoveryItem, "retainedPath" | "retainedPaths">,
): RecoveryConfirmation | null {
  switch (choice) {
    case "restore":
      return null;
    case "discard":
      return {
        title: "Discard this recovery record?",
        body: "This permanently deletes any retained files and removes recovery and Undo for this operation. Files at their visible locations, including any you changed since, are kept as they are. It cannot be undone.",
        confirm: "Discard recovery data",
      };
    case "release": {
      const folders = retainedFolders(item);
      const kept = folders.length > 0
        ? `Any remaining recovery files stay in ${listFolders(folders)} for you to review or delete.`
        : "Any remaining recovery files stay where they are for you to review or delete.";
      return {
        title: "Forget this recovery record?",
        body: `Nothing is deleted. File Recovery stops tracking this move and releases its locks; Undo is no longer available for it. ${kept}`,
        confirm: "Forget record",
      };
    }
  }
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Format a decimal-string byte counter without converting it to a number
 *  until it is provably small enough to be exact. */
export function formatRecoveryBytes(value: string | null): string {
  if (value === null || !isRecoveryCounter(value)) return "unknown";
  // Values beyond 2^53 cannot be exact as numbers; report them in TB from the
  // string length rather than silently rounding a counter.
  const bytes = value.length <= 15 ? Number(value) : Number(value.slice(0, 15)) * 10 ** (value.length - 15);
  let unit = 0;
  let scaled = bytes;
  while (scaled >= 1024 && unit < UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}

export interface RecoveryStorageSummary {
  usedLabel: string;
  budgetLabel: string;
  /** 0-100, clamped. 0 when the budget is unknown. */
  percent: number;
  atCapacity: boolean;
  /** Why reclaimable space may be lower than it looks. Empty when nothing
   *  needs explaining. */
  notes: string[];
}

/** Pure presentation of native retention accounting. */
export function summarizeRecoveryStorage(storage: FileRecoveryStorage): RecoveryStorageSummary {
  const used = isRecoveryCounter(storage.usedBytes) ? Number(storage.usedBytes) : 0;
  const budget = isRecoveryCounter(storage.budgetBytes) ? Number(storage.budgetBytes) : 0;
  const byBytes = budget > 0 ? (used / budget) * 100 : 0;
  const byRecords = storage.recordBudget > 0 ? (storage.records / storage.recordBudget) * 100 : 0;
  const notes: string[] = [];
  if (storage.unavailable > 0) {
    notes.push(`${storage.unavailable} ${storage.unavailable === 1 ? "record is" : "records are"} on an unavailable location and cannot be discarded`);
  }
  if (storage.unmeasured > 0) {
    notes.push(`${storage.unmeasured} ${storage.unmeasured === 1 ? "record has" : "records have"} not been measured yet`);
  }
  if (storage.atCapacity) {
    notes.push("New overwrites will not retain a recoverable copy until space is freed");
  }
  return {
    usedLabel: formatRecoveryBytes(storage.usedBytes),
    budgetLabel: formatRecoveryBytes(storage.budgetBytes),
    percent: Math.max(0, Math.min(100, Math.max(byBytes, byRecords))),
    atCapacity: storage.atCapacity,
    notes,
  };
}


/** Inventory does not probe user volumes. An unchanged pending record therefore
 * carries no new inspection result. Retain its prior presentation until native
 * authority changes; actions still undergo a fresh native claim when invoked. */
export function mergeRecoveryPresentation(previous: FileRecoverySnapshot, incoming: FileRecoverySnapshot): FileRecoverySnapshot {
  const prior = new Map(previous.items.map((item) => [item.id, item]));
  return {
    ...incoming,
    items: incoming.items.map((item) => {
      const inspected = prior.get(item.id);
      const keep = item.status === "pending" && inspected?.generation === item.generation
        && (inspected.status === "ready" || inspected.status === "attention" || inspected.status === "retained");
      const displayed = keep ? inspected : item;
      return { ...displayed, actions: [...displayed.actions] };
    }),
  };
}

export function cloneRecoveryItem(item: FileRecoveryItem): FileRecoveryItem {
  return { ...item, retainedBytes: item.retainedBytes ?? null, actions: [...item.actions] };
}

// ---- Inspection lifecycle --------------------------------------------------
//
// The explicit "Inspect" probe of one record. `token` identifies the request
// (the staleness fence); `generation` pins the record revision the result
// describes. Every transition returns the SAME state object when the event is
// stale, so callers can assign unconditionally.

export type RecoveryInspection =
  | { kind: "none" }
  /** `previous` is the last completed inspection, still displayed while the
   *  next probe runs (the UI shows it until it is replaced or cleared). */
  | { kind: "loading"; id: string; generation: string; token: number; previous: FileRecoveryItem | null }
  | { kind: "ready"; id: string; generation: string; item: FileRecoveryItem }
  /** `id`/`generation` are null when the record was already gone at request time. */
  | { kind: "failed"; id: string | null; generation: string | null; message: string };

export const NO_RECOVERY_INSPECTION: RecoveryInspection = { kind: "none" };

export function beginRecoveryInspection(state: RecoveryInspection, id: string, generation: string, token: number): RecoveryInspection {
  const previous = state.kind === "ready" ? state.item : state.kind === "loading" ? state.previous : null;
  return { kind: "loading", id, generation, token, previous };
}

/** The requested record is not in the snapshot at all. */
export function unavailableRecoveryInspection(message: string): RecoveryInspection {
  return { kind: "failed", id: null, generation: null, message };
}

export function isRecoveryInspectionRequest(state: RecoveryInspection, token: number): boolean {
  return state.kind === "loading" && state.token === token;
}

/** The probe returned a snapshot. Ready if the record is still present;
 *  otherwise there is nothing to show. */
export function settleRecoveryInspection(
  state: RecoveryInspection,
  token: number,
  items: readonly FileRecoveryItem[],
): RecoveryInspection {
  if (state.kind !== "loading" || state.token !== token) return state;
  const item = items.find(({ id }) => id === state.id);
  if (!item) return NO_RECOVERY_INSPECTION;
  return { kind: "ready", id: state.id, generation: item.generation, item: cloneRecoveryItem(item) };
}

/** The probe's result could not be used (stale or invalid snapshot). */
export function abandonRecoveryInspection(state: RecoveryInspection, token: number): RecoveryInspection {
  return isRecoveryInspectionRequest(state, token) ? NO_RECOVERY_INSPECTION : state;
}

/** The probe failed. The error is shown only if the record is still at the
 *  generation that was requested; otherwise the failure is moot. */
export function failRecoveryInspection(
  state: RecoveryInspection,
  token: number,
  items: readonly FileRecoveryItem[],
  message: string,
): RecoveryInspection {
  if (state.kind !== "loading" || state.token !== token) return state;
  const latest = items.find(({ id }) => id === state.id);
  if (latest?.generation !== state.generation) return NO_RECOVERY_INSPECTION;
  return { kind: "failed", id: state.id, generation: state.generation, message };
}

/** A new snapshot arrived. A settled inspection of a vanished or re-generated
 *  record is dropped; an in-flight probe settles on its own. */
export function reconcileRecoveryInspection(state: RecoveryInspection, items: readonly FileRecoveryItem[]): RecoveryInspection {
  if ((state.kind !== "ready" && state.kind !== "failed") || state.id === null) return state;
  const item = items.find(({ id }) => id === state.id);
  return !item || item.generation !== state.generation ? NO_RECOVERY_INSPECTION : state;
}

export const recoveryInspectingId = (s: RecoveryInspection): string | null => (s.kind === "loading" ? s.id : null);
export const recoveryInspectionId = (s: RecoveryInspection): string | null => (s.kind === "none" ? null : s.id);
export const recoveryInspectionGeneration = (s: RecoveryInspection): string | null => (s.kind === "none" ? null : s.generation);
export const recoveryInspectionItem = (s: RecoveryInspection): FileRecoveryItem | null =>
  s.kind === "ready" ? s.item : s.kind === "loading" ? s.previous : null;
export const recoveryInspectionError = (s: RecoveryInspection): string | null => (s.kind === "failed" ? s.message : null);

// ---- Resolve / reclaim operation ---------------------------------------------

/**
 * The one store mutation allowed at a time: a per-item action (`resolving`)
 * or explicit retention enforcement (`reclaiming`). Each owns its `token`, so
 * only the operation that began a state can settle it — a shared fence let a
 * resolve started during a reclaim strand the reclaim's busy flag (#1582).
 */
export type RecoveryOperation =
  | { kind: "idle" }
  | { kind: "resolving"; id: string; token: number }
  | { kind: "reclaiming"; token: number };

export const IDLE_RECOVERY_OPERATION: RecoveryOperation = { kind: "idle" };

export function beginRecoveryOperation(id: string, token: number): RecoveryOperation {
  return { kind: "resolving", id, token };
}

export function beginRecoveryReclaim(token: number): RecoveryOperation {
  return { kind: "reclaiming", token };
}

/** Whether any operation is in flight; a new one must not start meanwhile. */
export const isRecoveryOperationActive = (state: RecoveryOperation): boolean => state.kind !== "idle";

export function isRecoveryOperation(state: RecoveryOperation, token: number): boolean {
  return state.kind !== "idle" && state.token === token;
}

/** Finish operation `token`; a superseded or already-cleared one is a no-op. */
export function settleRecoveryOperation(state: RecoveryOperation, token: number): RecoveryOperation {
  return isRecoveryOperation(state, token) ? IDLE_RECOVERY_OPERATION : state;
}

export const isRecoveryReclaiming = (s: RecoveryOperation): boolean => s.kind === "reclaiming";
export const recoveryBusyId = (s: RecoveryOperation): string | null => (s.kind === "resolving" ? s.id : null);
