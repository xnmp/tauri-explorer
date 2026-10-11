/**
 * Shared drag state for in-app drag and drop.
 * Issue: tauri-5dq0
 *
 * Uses localStorage as a cross-window communication channel because
 * dataTransfer is unreliable between separate webview contexts in Tauri.
 * All webview windows share the same origin, so they can access the same
 * localStorage.
 */

import { loadPersisted, savePersisted, removePersisted } from "./persisted";
import { observedDuringGesture, internalDragPaths, sameDropPathSet } from "$lib/domain/file-drop";

const STORAGE_KEY = "explorer-drag-data";
const NATIVE_DECISION_KEY = "explorer-native-drag-decision";
const HTML5_GESTURES_KEY = "explorer-html5-gestures";
const HTML5_FLOOR_KEY = "explorer-html5-observation-floor";
const REJECTED_FLOOR_KEY = "explorer-rejected-html5-observation-floor";
type Html5Gesture = { data: DragData; ordinal: number; startedAt: number; endedAt?: number; nativeAccepted?: boolean; delivered?: boolean };
let html5History: Html5Gesture[] = [];
let observationFloor: number | null = null;
// A bounded history admits delayed observations across source-end/replacement.
// It is never eligible by path alone, and shares the existing window storage.
const readHtml5Gestures = (): Html5Gesture[] => {
  const value = loadPersisted<unknown>(HTML5_GESTURES_KEY, []);
  const persisted = Array.isArray(value) ? value.slice(-8).filter((item): item is Html5Gesture => !!item && typeof item === "object"
    && Number.isFinite(item.startedAt) && typeof item.data?.sessionId === "string" && !!item.data.sessionId
    && item.data.html5 === true && Number.isSafeInteger(item.ordinal) && item.ordinal > 0) : [];
  const storedFloor = loadPersisted<unknown>(HTML5_FLOOR_KEY, null);
  if (typeof storedFloor === "number" && Number.isFinite(storedFloor)) observationFloor = Math.max(observationFloor ?? storedFloor, storedFloor);
  const merged = new Map(html5History.map(item => [item.data.sessionId!, item]));
  for (const item of persisted) {
    const local = merged.get(item.data.sessionId!);
    merged.set(item.data.sessionId!, { ...item,
      endedAt: local?.endedAt === undefined ? item.endedAt : item.endedAt === undefined ? local.endedAt : Math.min(local.endedAt, item.endedAt),
      nativeAccepted: local?.nativeAccepted || item.nativeAccepted,
      delivered: local?.delivered || item.delivered });
  }
  retainHtml5Gestures([...merged.values()]);
  return html5History;
};
// Date.now and Rust SystemTime use the live wall clock. performance.timeOrigin
// is origin-anchored and would diverge from Rust after an OS clock adjustment.
const observedNow = () => Date.now();
function retainHtml5Gestures(history: Html5Gesture[]): void {
  // Sequence order survives wall-clock adjustments and stale storage copies.
  history = history.filter(item => observationFloor === null || item.endedAt === undefined || item.endedAt > observationFloor)
    .sort((a, b) => a.ordinal - b.ordinal || a.startedAt - b.startedAt);
  if (history.length > 8) {
    const discarded = history.slice(0, -8);
    observationFloor = Math.max(observationFloor ?? -Infinity, ...discarded.map(item => item.endedAt ?? item.startedAt));
    savePersisted(HTML5_FLOOR_KEY, observationFloor);
  }
  html5History = history.slice(-8);
}
const writeHtml5Gestures = (history: Html5Gesture[]): void => {
  retainHtml5Gestures(history);
  savePersisted(HTML5_GESTURES_KEY, html5History);
};
const updateHtml5Gesture = (id: string, patch: Partial<Html5Gesture>): void => {
  const history = readHtml5Gestures();
  if (history.some(item => item.data.sessionId === id)) writeHtml5Gestures(
    history.map(item => item.data.sessionId === id ? { ...item, ...patch } : item));
};
type NativeDecision = { sessionId: string; accepted: boolean; html5StartedAt?: number; html5EndedAt?: number };
const saveNativeDecision = (next: NativeDecision): void => {
  const previous = loadPersisted<NativeDecision | null>(NATIVE_DECISION_KEY, null);
  if (previous && previous.sessionId !== next.sessionId && !previous.accepted && Number.isFinite(previous.html5StartedAt)) {
    // The small decision record may be the only cross-window evidence when
    // path-history writes fail. Publish cancellation authority before replacing
    // it; this floor does not evict locally/persistently proven source history.
    const stored = loadPersisted<unknown>(REJECTED_FLOOR_KEY, null);
    const floor = Math.max(typeof stored === "number" && Number.isFinite(stored) ? stored : -Infinity,
      previous.html5StartedAt!, previous.html5EndedAt ?? next.html5StartedAt ?? observedNow());
    savePersisted(REJECTED_FLOOR_KEY, floor);
  }
  savePersisted(NATIVE_DECISION_KEY, next);
};

export interface DragData {
  path: string;
  name: string;
  kind: string;
  /** Additional paths when dragging a multi-selection */
  paths?: string[];
  /** Host-issued gesture identity, also carried across windows. */
  sessionId?: string;
  /** Source policy survives native handoff; modifier intent is read at drop. */
  nativeCopyPolicy?: "modifier" | "move" | "link";
  transport?: "native-pending" | "native";
  /** True only while this source's original HTML5 gesture is alive. Linux can
   * still receive automatic Wry events when explicit native start rejects. */
  html5?: boolean;
  html5StartedAt?: number;
}

let current: DragData | null = $state.raw(null);
const claimed = new Set<string>();
const nativeLeases = new Map<string, { endRequested: boolean; ready: Promise<boolean>; settle(accepted: boolean): void }>();
let nativeOwnedSession: string | undefined;
const retained = new Map<string, number>();
const deferredEnds = new Set<string>();
const domSources = new WeakMap<DataTransfer, DragData>();

function updateTransport(data: DragData, transport: DragData["transport"]): void {
  if (current && current.sessionId === data.sessionId) current = { ...current, transport };
  const persisted = loadPersisted<DragData | null>(STORAGE_KEY, null);
  if (persisted?.sessionId === data.sessionId) savePersisted(STORAGE_KEY, { ...persisted, transport });
}

export const dragState = {
  get current() { return current; },

  start(data: DragData) {
    const startedAt = observedNow();
    // Only one physical gesture is active. Replacement also retires an old
    // interval whose source component missed dragend during unmount.
    const history = readHtml5Gestures().map(item => item.endedAt === undefined ? { ...item, endedAt: startedAt } : item);
    current = { ...data, ...(data.html5 ? { html5StartedAt: startedAt } : {}), paths: data.paths ? [...data.paths] : undefined, sessionId: crypto.randomUUID() };
    savePersisted(STORAGE_KEY, current);
    const ordinal = Math.max(0, ...history.map(item => item.ordinal)) + 1;
    writeHtml5Gestures(data.html5 ? [...history, { data: current, startedAt, ordinal }] : history);
  },

  clear(dataTransfer?: DataTransfer | null) {
    if (dataTransfer !== undefined) {
      this.claim(dataTransfer ? this.domSource(dataTransfer) : null)?.finish();
      return;
    }
    this.finish(current ?? this.readCrossWindow());
  },

  bindDomSource(dataTransfer: DataTransfer, data: DragData): void {
    domSources.set(dataTransfer, data);
  },

  endHtml5(data: DragData | null): void {
    if (!data?.sessionId) return;
    // End is idempotent; a delayed old source must not extend its interval.
    const gesture = readHtml5Gestures().find(item => item.data.sessionId === data.sessionId);
    if (gesture && gesture.endedAt === undefined) updateHtml5Gesture(data.sessionId, { endedAt: observedNow() });
    if (current?.sessionId === data.sessionId) current = { ...current, html5: false };
    const persisted = this.readCrossWindow();
    if (persisted?.sessionId === data.sessionId) savePersisted(STORAGE_KEY, { ...persisted, html5: false });
    const decision = loadPersisted<NativeDecision | null>(NATIVE_DECISION_KEY, null);
    if (decision?.sessionId === data.sessionId && !decision.accepted && data.html5StartedAt !== undefined) {
      const endedAt = gesture?.endedAt ?? observedNow();
      savePersisted(NATIVE_DECISION_KEY, { ...decision, html5StartedAt: data.html5StartedAt,
        html5EndedAt: decision.html5EndedAt === undefined ? endedAt : Math.min(decision.html5EndedAt, endedAt) });
    }
  },

  survivingHtml5Source(observedAt?: number): DragData | null {
    const data = current ?? this.readCrossWindow();
    if (observedAt !== undefined) return [...readHtml5Gestures()].reverse().find(item => !item.nativeAccepted
      && (item.endedAt !== undefined || item.delivered || (data && item.data.sessionId === data.sessionId && data.html5 && data.transport !== "native"))
      && observedDuringGesture(observedAt, item.startedAt, item.endedAt))?.data
      ?? (data?.html5 && data.transport !== "native" && observedDuringGesture(observedAt, data.html5StartedAt ?? NaN) ? data : null);
    return data?.html5 && data.transport !== "native" ? data : null;
  },

  expiredNativeObservation(observedAt?: number): boolean {
    if (observedAt === undefined) return false;
    const history = readHtml5Gestures();
    const decision = loadPersisted<NativeDecision | null>(NATIVE_DECISION_KEY, null);
    const rejectedFloor = loadPersisted<unknown>(REJECTED_FLOOR_KEY, null);
    // A small decision record survives history-only quota failures. A peer
    // lacking the source paths must cancel the original interval, never call
    // it external. Live source data/local history can still prove identity.
    const missingRejectedHistory = decision && !decision.accepted && decision.html5StartedAt !== undefined
      && !history.some(item => item.data.sessionId === decision.sessionId)
      && observedDuringGesture(observedAt, decision.html5StartedAt, decision.html5EndedAt === undefined ? undefined : decision.html5EndedAt + 1);
    // JS wall time has millisecond precision. An observation in the source's
    // end millisecond is ambiguous; fail closed rather than guess provenance.
    return !Number.isFinite(observedAt) || !!missingRejectedHistory
      || (typeof rejectedFloor === "number" && Number.isFinite(rejectedFloor) && Math.floor(observedAt) <= rejectedFloor)
      || (observationFloor !== null && Math.floor(observedAt) <= observationFloor)
      || history.some(item => item.endedAt !== undefined && (Math.floor(observedAt) === item.endedAt
        || (item.endedAt < item.startedAt && observedAt <= item.startedAt + 1)));
  },

  cancelledNativeSession(observedAt: number | undefined, paths: readonly string[], windows: boolean): string | undefined {
    if (observedAt === undefined) return;
    // A boundary observation is insufficient for delivery, but its complete
    // path match can suppress that retired gesture's possible DOM duplicate.
    return [...readHtml5Gestures()].reverse().find(item => item.endedAt !== undefined
      && observedAt >= Math.min(item.startedAt, item.endedAt) && observedAt < Math.max(item.startedAt, item.endedAt) + 1
      && sameDropPathSet(paths, internalDragPaths(item.data, windows) ?? [], windows))?.data.sessionId;
  },

  expiredDomSource(data: DragData | null, transfer?: DataTransfer | null): boolean {
    const history = readHtml5Gestures();
    const id = data?.sessionId || transfer?.getData("application/x-explorer-session");
    if (id && history.some(item => item.data.sessionId === id)) return false;
    const stamp = data?.html5StartedAt ?? Number(transfer?.getData("application/x-explorer-observed-at") || NaN);
    return Number.isFinite(stamp) && observationFloor !== null && stamp <= observationFloor;
  },

  domSource(dataTransfer: DataTransfer): DragData | null {
    const captured = domSources.get(dataTransfer);
    if (captured) return captured;
    const id = dataTransfer.getData("application/x-explorer-session");
    const live = current ?? this.readCrossWindow();
    return !id || live?.sessionId === id ? live : null;
  },

  finish(data: DragData | null, delivered = false): void {
    if (!data) return;
    if (data.html5 && !delivered) this.endHtml5(data);
    const persisted = loadPersisted<DragData | null>(STORAGE_KEY, null);
    const live = current?.sessionId === data.sessionId ? current : persisted?.sessionId === data.sessionId ? persisted : data;
    if (!delivered && data.sessionId && retained.has(data.sessionId)) {
      deferredEnds.add(data.sessionId);
      return;
    }
    if (delivered && data.sessionId) deferredEnds.delete(data.sessionId);
    if (!delivered && live?.transport) {
      const lease = data.sessionId && nativeLeases.get(data.sessionId);
      if (lease) lease.endRequested = true;
      return;
    }
    if (current === data || (data.sessionId && current?.sessionId === data.sessionId)) current = null;
    if (data.sessionId && persisted?.sessionId === data.sessionId) removePersisted(STORAGE_KEY);
  },

  /** Reserve before IPC, acknowledge on successful start, and retire only on
   * delivery/cancellation. Failed starts return authority to the DOM source. */
  beginNative(data: DragData | null) {
    const id = data?.sessionId;
    if (!data || !id) return { acknowledge() {}, failed() {}, complete() {} };
    let settle!: (accepted: boolean) => void;
    const ready = new Promise<boolean>(resolve => { settle = resolve; });
    const lease = { endRequested: false, ready, settle };
    nativeLeases.set(id, lease);
    updateTransport(data, "native-pending");
    return {
      acknowledge: () => {
        if (nativeLeases.get(id) !== lease) return;
        nativeOwnedSession = id;
        updateHtml5Gesture(id, { nativeAccepted: true });
        saveNativeDecision({ sessionId: id, accepted: true });
        updateTransport(data, "native");
        settle(true);
      },
      failed: () => {
        nativeLeases.delete(id);
        saveNativeDecision({ sessionId: id, accepted: false,
          html5StartedAt: data.html5StartedAt, html5EndedAt: readHtml5Gestures().find(item => item.data.sessionId === id)?.endedAt });
        updateTransport(data, undefined);
        if (lease.endRequested) this.finish(data);
        settle(false);
      },
      complete: () => {
        updateHtml5Gesture(id, { nativeAccepted: true });
        nativeOwnedSession = id;
        saveNativeDecision({ sessionId: id, accepted: true });
        nativeLeases.delete(id); this.finish(data, true); settle(true);
      },
    };
  },

  nativeOwns(sessionId?: string): boolean {
    const data = current ?? this.readCrossWindow();
    return sessionId ? nativeOwnedSession === sessionId || (data?.sessionId === sessionId && data.transport === "native")
      : data?.transport === "native";
  },

  pendingNative(): { result: Promise<boolean>; dispose(): void } | undefined {
    const data = current ?? this.readCrossWindow();
    if (data?.transport !== "native-pending" || !data.sessionId) return;
    const local = nativeLeases.get(data.sessionId);
    if (local) return { result: local.ready, dispose() {} };
    // Another renderer owns the start-command promise. Storage events carry
    // its decision even if a later source result already removed the record.
    let finish!: (accepted: boolean) => void;
    const result = new Promise<boolean>(resolve => { finish = resolve; });
    const decide = (next: DragData | null) => {
      const decision = loadPersisted<NativeDecision | null>(NATIVE_DECISION_KEY, null);
      const accepted = decision && decision.sessionId === data.sessionId ? decision.accepted : undefined;
      if (accepted === undefined && next && next.sessionId === data.sessionId && next.transport === "native-pending") return;
      window.removeEventListener("storage", observe);
      finish(accepted ?? (next?.sessionId !== data.sessionId || next?.transport === "native"));
    };
    const observe = (event: StorageEvent) => {
      if (event.key === NATIVE_DECISION_KEY) { decide(this.readCrossWindow()); return; }
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      try { decide(event.newValue ? JSON.parse(event.newValue) : null); }
      catch { decide(null); }
    };
    window.addEventListener("storage", observe);
    decide(this.readCrossWindow());
    return { result, dispose: () => { window.removeEventListener("storage", observe); finish(true); } };
  },

  /** Keep a readable DOM source until an in-flight native start is decided. */
  retain(data: DragData | null = current): () => void {
    const id = data?.sessionId;
    if (!data || !id) return () => {};
    retained.set(id, (retained.get(id) ?? 0) + 1);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const count = retained.get(id)! - 1;
      if (count) retained.set(id, count);
      else { retained.delete(id); if (deferredEnds.delete(id)) this.finish(data); }
    };
  },

  /** Read drag data from localStorage (cross-window fallback) */
  readCrossWindow(): DragData | null {
    return loadPersisted<DragData | null>(STORAGE_KEY, null);
  },

  /** Claim before invoking async consumers. Cleanup compares gesture identity
   * both locally and in shared storage, so a replacement drag survives. */
  claim(data: DragData | null = current ?? loadPersisted<DragData | null>(STORAGE_KEY, null)): { finish: () => void } | null {
    // External gestures have no Explorer session to retire.
    if (!data) return { finish: () => {} };
    const id = data?.sessionId;
    if (id && (claimed.has(id) || readHtml5Gestures().some(item => item.data.sessionId === id && item.delivered))) return null;
    if (id) claimed.add(id);
    return { finish: () => {
      if (id) claimed.delete(id);
      if (id) updateHtml5Gesture(id, { delivered: true });
      this.finish(data, true);
    } };
  },
};
