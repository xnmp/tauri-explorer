/**
 * Mock File Recovery commands: the retained-destination records, their budget and the
 * subscription snapshot the recovery panel receives.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import type { CommandHandler } from "./mock-dispatch";


// --- File Recovery fixture (ADR 0023 retention/retirement) -----------------
// The browser build exercises the same commands as the native backend so the
// storage budget, discard control and retained-evidence failure state are
// reachable without Tauri.
interface MockRecoveryRecord {
  id: string;
  generation: bigint;
  originalPath: string;
  retainedPath: string | null;
  retainedBytes: string | null;
  status: "pending" | "busy" | "ready" | "attention" | "retained";
  message: string;
  actions: ("restore" | "discard" | "release")[];
  autoEligible: boolean;
  /** Simulates a cleanup that cannot remove its artifacts (EACCES, missing volume). */
  cleanupFails: boolean;
  /** A move whose committed discard stopped: it can only be retried or forgotten. */
  stranded?: boolean;
}

const MOCK_STRANDED_MESSAGE = "Discard stopped before finishing; its Undo history is gone and the remaining recovery files are preserved. Retry Discard once this is resolved: Read-only file system (os error 30). If it cannot be resolved, Forget releases this record and its locks without deleting anything; its remaining files stay in the listed folder";

const mockRecoveryBudgetBytes = 2 * 1024 * 1024 * 1024;
let mockRecoveryRevision = 4n;
let mockRecoveryRecords: MockRecoveryRecord[] = [
  {
    id: "a".repeat(64),
    generation: 11n,
    originalPath: "/home/user/Documents/quarterly-report.md",
    retainedPath: "/home/user/Documents/.tauri-explorer-recovery-6f2a",
    retainedBytes: "742391808",
    status: "retained",
    message: "Inspect these retained recovery files to restore or discard them",
    actions: [],
    autoEligible: false,
    cleanupFails: false,
  },
  {
    id: "b".repeat(64),
    generation: 7n,
    originalPath: "/run/media/user/Archive/photos/2024-summer",
    retainedPath: "/run/media/user/Archive/photos/.tauri-explorer-recovery-c81d",
    retainedBytes: null,
    status: "retained",
    message: "Inspect these retained recovery files to restore or discard them",
    actions: [],
    autoEligible: false,
    cleanupFails: true,
  },
  {
    id: "c".repeat(64),
    generation: 5n,
    originalPath: "/run/media/user/Backup/site-assets",
    retainedPath: "/run/media/user/Backup/.tauri-explorer-recovery-9e41",
    retainedBytes: "18874368",
    status: "attention",
    message: MOCK_STRANDED_MESSAGE,
    actions: [],
    autoEligible: false,
    cleanupFails: true,
    stranded: true,
  },
];
let mockRecoveryError: string | null = null;
let mockRecoveryReceive: ((snapshot: unknown) => void) | null = null;

function mockRecoverySnapshot(): unknown {
  const used = mockRecoveryRecords.reduce((total, record) => total + Number(record.retainedBytes ?? 0), 0);
  const unmeasured = mockRecoveryRecords.filter((record) => record.retainedBytes === null).length;
  return {
    revision: mockRecoveryRevision.toString(),
    items: mockRecoveryRecords.map(({ autoEligible: _auto, cleanupFails: _fails, stranded: _stranded, generation, ...item }) => ({
      ...item,
      generation: generation.toString(),
      actions: [...item.actions],
    })),
    storage: {
      usedBytes: used.toString(),
      budgetBytes: mockRecoveryBudgetBytes.toString(),
      records: mockRecoveryRecords.length,
      recordBudget: 256,
      unmeasured,
      unavailable: mockRecoveryRecords.filter((record) => record.cleanupFails).length,
      discardable: mockRecoveryRecords.filter((record) => record.status === "retained" || record.status === "ready").length,
      atCapacity: used >= mockRecoveryBudgetBytes,
    },
    error: mockRecoveryError,
  };
}

function mockRecoveryPublish(): unknown {
  const snapshot = mockRecoverySnapshot();
  mockRecoveryReceive?.(snapshot);
  return snapshot;
}

export const fileRecoveryCommands: Record<string, CommandHandler> = {
  file_recovery_subscribe: ({ updates }) => {
    mockRecoveryReceive = updates as (snapshot: unknown) => void;
    return mockRecoverySnapshot();
  },
  file_recovery_unsubscribe: () => {
    mockRecoveryReceive = null;
    return null;
  },
  file_recovery_list: () => mockRecoverySnapshot(),
  file_recovery_retire_eligible: () => {
    const before = mockRecoveryRecords.length;
    mockRecoveryRecords = mockRecoveryRecords.filter((record) => !record.autoEligible);
    if (mockRecoveryRecords.length !== before) mockRecoveryRevision += 1n;
    mockRecoveryError = null;
    return mockRecoveryPublish();
  },
  file_recovery_inspect: ({ id }) => {
    const record = mockRecoveryRecords.find((candidate) => candidate.id === id);
    if (!record) throw new Error("Recovery operation is no longer available");
    record.generation += 1n;
    mockRecoveryRevision += 1n;
    if (record.stranded) {
      record.status = "attention";
      record.message = MOCK_STRANDED_MESSAGE;
      record.actions = ["discard", "release"];
    } else {
      record.status = "retained";
      record.message = "Retained recovery files can be discarded";
      record.actions = ["discard"];
    }
    record.retainedBytes ??= "1073741824";
    mockRecoveryError = null;
    return mockRecoveryPublish();
  },
  file_recovery_resolve: ({ id, generation, choice }) => {
    const record = mockRecoveryRecords.find((candidate) => candidate.id === id);
    if (!record || record.generation.toString() !== generation) {
      throw new Error("Recovery operation changed; inspect it again before acting");
    }
    record.generation += 1n;
    mockRecoveryRevision += 1n;
    if (choice === "release" && !record.stranded) {
      mockRecoveryError = "Only a move whose discard stopped before finishing can be forgotten";
      return mockRecoveryPublish();
    }
    if (choice === "discard" && record.stranded) {
      // The committed discard stops again; it can still be retried or forgotten.
      record.status = "attention";
      record.actions = ["discard", "release"];
      record.message = MOCK_STRANDED_MESSAGE;
      mockRecoveryError = `Could not remove ${record.retainedPath}: Read-only file system (os error 30)`;
      return mockRecoveryPublish();
    }
    if (choice === "discard" && record.cleanupFails) {
      // Retained-evidence failure: nothing is removed and the record stays.
      record.status = "attention";
      record.actions = [];
      record.message = "Retained recovery files could not be removed; every file is preserved";
      mockRecoveryError = `Could not remove ${record.retainedPath}: the location is unavailable`;
      return mockRecoveryPublish();
    }
    mockRecoveryRecords = mockRecoveryRecords.filter((candidate) => candidate.id !== id);
    mockRecoveryError = null;
    return mockRecoveryPublish();
  },
};
