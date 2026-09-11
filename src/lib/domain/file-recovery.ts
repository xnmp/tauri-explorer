/** Native recovery records are capabilities by ID, never renderer-owned paths. */
export type FileRecoveryChoice = "restore" | "discard";

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
  retainedPath: string | null;
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
