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
  status: "pending" | "busy" | "ready" | "attention";
  message: string;
  actions: FileRecoveryChoice[];
}

export interface FileRecoverySnapshot {
  revision: string;
  items: FileRecoveryItem[];
  error: string | null;
}

/** A subscription owns discovery; inspect is the explicit filesystem probe. */
export interface FileRecoveryPort {
  subscribe(receive: (snapshot: FileRecoverySnapshot) => void): Promise<() => Promise<void>>;
  list(): Promise<FileRecoverySnapshot>;
  inspect(id: string): Promise<FileRecoverySnapshot>;
  resolve(id: string, generation: string, choice: FileRecoveryChoice): Promise<FileRecoverySnapshot>;
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
        && (inspected.status === "ready" || inspected.status === "attention");
      const displayed = keep ? inspected : item;
      return { ...displayed, actions: [...displayed.actions] };
    }),
  };
}
