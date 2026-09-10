import { fileRecoveryPort } from "$lib/api/file-recovery";
import { extractError } from "$lib/api/common";
import { compareRecoveryCounters, emptyRecoveryStorage, isRecoveryCounter, mergeRecoveryPresentation } from "$lib/domain/file-recovery";
import type {
  FileRecoveryChoice,
  FileRecoveryItem,
  FileRecoveryPort,
  FileRecoverySnapshot,
  FileRecoveryStorage,
} from "$lib/domain/file-recovery";

const EMPTY_SNAPSHOT: FileRecoverySnapshot = { revision: "0", items: [], storage: emptyRecoveryStorage(), error: null };
const INVALID_UPDATE = "Recovery status update was invalid";
const STATUSES = new Set(["pending", "busy", "ready", "attention", "retained"]);
const CHOICES = new Set<FileRecoveryChoice>(["restore", "discard"]);

function validItem(value: unknown): value is FileRecoveryItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<FileRecoveryItem>;
  return typeof item.id === "string" && item.id.length > 0
    && isRecoveryCounter(item.generation)
    && typeof item.originalPath === "string"
    && (item.retainedPath === null || typeof item.retainedPath === "string")
    && (item.retainedBytes === null || isRecoveryCounter(item.retainedBytes))
    && typeof item.status === "string" && STATUSES.has(item.status)
    && typeof item.message === "string"
    && Array.isArray(item.actions)
    && new Set(item.actions).size === item.actions.length
    && item.actions.every((choice) => CHOICES.has(choice));
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validStorage(value: unknown): value is FileRecoveryStorage {
  if (!value || typeof value !== "object") return false;
  const storage = value as Partial<FileRecoveryStorage>;
  return isRecoveryCounter(storage.usedBytes) && isRecoveryCounter(storage.budgetBytes)
    && validCount(storage.records) && validCount(storage.recordBudget)
    && validCount(storage.unmeasured) && validCount(storage.unavailable)
    && validCount(storage.discardable)
    && typeof storage.atCapacity === "boolean";
}

function validSnapshot(value: unknown): value is FileRecoverySnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<FileRecoverySnapshot>;
  return validStorage(snapshot.storage)
    && isRecoveryCounter(snapshot.revision)
    && Array.isArray(snapshot.items) && snapshot.items.every(validItem)
    && new Set(snapshot.items.map((item) => item.id)).size === snapshot.items.length
    && (snapshot.error === null || typeof snapshot.error === "string");
}

function cloneItem(item: FileRecoveryItem): FileRecoveryItem {
  return { ...item, actions: [...item.actions] };
}

function cloneSnapshot(snapshot: FileRecoverySnapshot): FileRecoverySnapshot {
  return { revision: snapshot.revision, items: snapshot.items.map(cloneItem), storage: { ...snapshot.storage }, error: snapshot.error };
}

export function createFileRecoveryState(port: FileRecoveryPort = fileRecoveryPort) {
  let snapshot = $state<FileRecoverySnapshot>(cloneSnapshot(EMPTY_SNAPSHOT));
  let loading = $state(false);
  let busyId = $state<string | null>(null);
  let inspectingId = $state<string | null>(null);
  let inspectionId = $state<string | null>(null);
  let inspectionGeneration = $state<string | null>(null);
  let inspection = $state<FileRecoveryItem | null>(null);
  let inspectionError = $state<string | null>(null);

  let running = false;
  let owner = 0;
  let refreshRequest = 0;
  let inspectRequest = 0;
  let resolveRequest = 0;
  interface Subscription {
    token: number;
    registration: Promise<void>;
    release: (() => Promise<void>) | null;
    releaseRequested: boolean;
    releaseTask: Promise<void> | null;
  }
  const subscriptions = new Set<Subscription>();

  function current(token: number): boolean {
    return running && token === owner;
  }

  function apply(value: unknown, token: number): boolean {
    if (!current(token)) return false;
    if (!validSnapshot(value)) {
      snapshot = { ...snapshot, error: INVALID_UPDATE };
      return false;
    }
    if (compareRecoveryCounters(value.revision, snapshot.revision) < 0) return false;
    snapshot = mergeRecoveryPresentation(snapshot, value);
    if (inspectionId && !inspectingId) {
      const item = snapshot.items.find(({ id }) => id === inspectionId);
      if (!item || item.generation !== inspectionGeneration) clearInspection();
    }
    return true;
  }

  function clearInspection(): void {
    ++inspectRequest;
    inspectingId = null;
    inspectionId = null;
    inspectionGeneration = null;
    inspection = null;
    inspectionError = null;
  }

  function releaseSubscription(subscription: Subscription): Promise<void> {
    subscription.releaseRequested = true;
    if (subscription.releaseTask) return subscription.releaseTask;
    const attempt = subscription.registration.then(async () => {
      if (!subscription.release) {
        subscriptions.delete(subscription);
        return;
      }
      await subscription.release();
      subscriptions.delete(subscription);
    });
    subscription.releaseTask = attempt;
    void attempt.then(undefined, () => {
      if (subscription.releaseTask === attempt) subscription.releaseTask = null;
    });
    return attempt;
  }

  function retireSubscriptions(): void {
    for (const subscription of subscriptions) {
      void releaseSubscription(subscription).catch(() => {});
    }
  }

  function start(): Promise<void> {
    const token = ++owner;
    ++refreshRequest;
    ++inspectRequest;
    ++resolveRequest;
    running = true;
    loading = true;
    busyId = null;
    clearInspection();
    retireSubscriptions();

    const subscription: Subscription = {
      token,
      registration: Promise.resolve(),
      release: null,
      releaseRequested: false,
      releaseTask: null,
    };
    subscriptions.add(subscription);
    let registration: Promise<() => Promise<void>>;
    try {
      registration = port.subscribe((next) => { apply(next, subscription.token); });
    } catch (error) {
      registration = Promise.reject(error);
    }
    subscription.registration = registration.then(
      (release) => {
        subscription.release = release;
        if (subscription.releaseRequested || !current(subscription.token)) {
          void releaseSubscription(subscription).catch(() => {});
          return;
        }
        loading = false;
      },
      (error) => {
        subscriptions.delete(subscription);
        if (current(token)) {
          loading = false;
          snapshot = { ...snapshot, error: extractError(error) };
        }
      },
    );
    return subscription.registration.then(async () => {
      if (subscription.releaseRequested || !current(token)) {
        await releaseSubscription(subscription);
      }
    });
  }

  function dispose(): Promise<void> {
    ++owner;
    ++refreshRequest;
    ++inspectRequest;
    ++resolveRequest;
    running = false;
    loading = false;
    busyId = null;
    clearInspection();
    snapshot = cloneSnapshot(EMPTY_SNAPSHOT);
    const pending = [...subscriptions].map(async (subscription) => {
      try {
        await releaseSubscription(subscription);
      } catch {
        // A replacement attachment does not wait for a retired owner's failed
        // release. Sealed teardown gets one fresh exact-token retry and reports
        // that result if native cleanup is still unavailable.
        await releaseSubscription(subscription);
      }
    });
    return Promise.allSettled(pending).then((results) => {
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    });
  }

  async function refresh(): Promise<void> {
    if (!running) return;
    const token = owner;
    const operation = ++refreshRequest;
    loading = true;
    try {
      const next = await port.list();
      if (current(token) && (validSnapshot(next) || operation === refreshRequest)) apply(next, token);
    } catch (error) {
      if (current(token) && operation === refreshRequest) {
        snapshot = { ...snapshot, error: extractError(error) };
      }
    } finally {
      if (current(token) && operation === refreshRequest) loading = false;
    }
  }

  async function inspect(id: string): Promise<void> {
    if (!running) return;
    const currentItem = snapshot.items.find((item) => item.id === id);
    if (!currentItem) {
      clearInspection();
      inspectionError = "Recovery item is no longer available";
      return;
    }
    const token = owner;
    const operation = ++inspectRequest;
    const generation = currentItem.generation;
    inspectingId = id;
    inspectionId = id;
    inspectionGeneration = generation;
    inspectionError = null;
    try {
      const next = await port.inspect(id);
      if (!current(token) || operation !== inspectRequest) return;
      if (!apply(next, token)) {
        clearInspection();
        return;
      }
      const currentItem = snapshot.items.find((candidate) => candidate.id === id);
      if (!currentItem) {
        clearInspection();
        return;
      }
      inspectionGeneration = currentItem.generation;
      inspection = cloneItem(currentItem);
    } catch (error) {
      if (current(token) && operation === inspectRequest) {
        const latest = snapshot.items.find((candidate) => candidate.id === id);
        if (latest?.generation === generation) {
          inspection = null;
          inspectionError = extractError(error);
        } else {
          clearInspection();
        }
      }
    } finally {
      if (current(token) && operation === inspectRequest) inspectingId = null;
    }
  }

  /** Explicit retention enforcement. Shares the resolve request fence so it
   *  cannot interleave with an in-flight per-item action. */
  async function retireEligible(): Promise<void> {
    if (!running || busyId) return;
    const token = owner;
    const operation = ++resolveRequest;
    loading = true;
    try {
      const next = await port.retireEligible();
      if (current(token) && operation === resolveRequest) apply(next, token);
    } catch (error) {
      if (current(token) && operation === resolveRequest) {
        snapshot = { ...snapshot, error: extractError(error) };
      }
    } finally {
      if (current(token) && operation === resolveRequest) loading = false;
    }
  }

  async function resolve(item: FileRecoveryItem, choice: FileRecoveryChoice): Promise<void> {
    if (!running || busyId) return;
    const latest = snapshot.items.find(({ id }) => id === item.id);
    if (!latest || latest.generation !== item.generation || !latest.actions.includes(choice)) {
      snapshot = { ...snapshot, error: `Recovery action is no longer authorized: ${choice}` };
      return;
    }
    const token = owner;
    const operation = ++resolveRequest;
    busyId = item.id;
    try {
      const next = await port.resolve(latest.id, latest.generation, choice);
      if (current(token) && operation === resolveRequest) apply(next, token);
    } catch (error) {
      if (current(token) && operation === resolveRequest) {
        snapshot = { ...snapshot, error: extractError(error) };
      }
    } finally {
      if (current(token) && operation === resolveRequest) busyId = null;
    }
  }

  return {
    get snapshot() { return snapshot; },
    get items() { return snapshot.items; },
    get storage() { return snapshot.storage; },
    get error() { return snapshot.error; },
    get loading() { return loading; },
    get busyId() { return busyId; },
    get inspectingId() { return inspectingId; },
    get inspectionId() { return inspectionId; },
    get inspectionGeneration() { return inspectionGeneration; },
    get inspection() { return inspection; },
    get inspectionError() { return inspectionError; },
    start,
    dispose,
    refresh,
    inspect,
    resolve,
    retireEligible,
  };
}

export type FileRecoveryState = ReturnType<typeof createFileRecoveryState>;
