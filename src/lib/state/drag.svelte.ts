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

const STORAGE_KEY = "explorer-drag-data";
const NATIVE_DECISION_KEY = "explorer-native-drag-decision";
type NativeDecision = { sessionId: string; accepted: boolean };

export interface DragData {
  path: string;
  name: string;
  kind: string;
  /** Additional paths when dragging a multi-selection */
  paths?: string[];
  /** Host-issued gesture identity, also carried across windows. */
  sessionId?: string;
  /** Source policy survives native handoff; modifier intent is read at drop. */
  nativeCopyPolicy?: "modifier" | "move";
  transport?: "native-pending" | "native";
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
    current = { ...data, paths: data.paths ? [...data.paths] : undefined, sessionId: crypto.randomUUID() };
    savePersisted(STORAGE_KEY, current);
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

  domSource(dataTransfer: DataTransfer): DragData | null {
    const captured = domSources.get(dataTransfer);
    if (captured) return captured;
    const id = dataTransfer.getData("application/x-explorer-session");
    const live = current ?? this.readCrossWindow();
    return !id || live?.sessionId === id ? live : null;
  },

  finish(data: DragData | null, delivered = false): void {
    if (!data) return;
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
        savePersisted<NativeDecision>(NATIVE_DECISION_KEY, { sessionId: id, accepted: true });
        updateTransport(data, "native");
        settle(true);
      },
      failed: () => {
        nativeLeases.delete(id);
        savePersisted<NativeDecision>(NATIVE_DECISION_KEY, { sessionId: id, accepted: false });
        updateTransport(data, undefined);
        if (lease.endRequested) this.finish(data);
        settle(false);
      },
      complete: () => {
        nativeOwnedSession = id;
        savePersisted<NativeDecision>(NATIVE_DECISION_KEY, { sessionId: id, accepted: true });
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
    if (id && claimed.has(id)) return null;
    if (id) claimed.add(id);
    return { finish: () => {
      if (id) claimed.delete(id);
      this.finish(data, true);
    } };
  },
};
