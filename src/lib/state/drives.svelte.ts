import {
  listDrives, driveUpdatesLive, DRIVES_CHANGED_EVENT, type Drive, type DrivesChanged,
} from "$lib/api/drives";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createDirectoryWatch } from "./directory-watch";
import { directoryKey } from "$lib/domain/path";
import { sidebarCloudDrives } from "$lib/domain/drives";
import { pageForeground, type ForegroundGate } from "./page-foreground";

// Change sources: the backend's `drives-changed` push, fs-watcher events on
// macOS's `/Volumes`, and a poll. On Linux the backend pushes UDisks2, mount
// table and GVfs changes itself (#888), so no directory is watched here. While
// the UDisks subscription is live the poll is only a backstop. Without it
// (browser mode, macOS, Windows, Linux without UDisks) the poll is the primary
// source and stays fast.
export const PUSHED_POLL_INTERVAL_MS = 30_000;
export const UNPUSHED_POLL_INTERVAL_MS = 1500;

/** Directories whose entries track mounts, where no backend push covers them. */
function detectMountBases(): string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.userAgent.toLowerCase().includes("mac") ? ["/Volumes"] : [];
}

/** Normalised mount roots of drives that have one (unmounted volumes do not). */
function mountRoots(drives: readonly Drive[]): string[] {
  return drives.flatMap((d) => (d.path === null ? [] : [directoryKey(d.path)]));
}

/** A page drive store whose feeds start only while `foreground` is open. */
export function createDrivesStore(foreground: ForegroundGate) {
  let drives = $state<Drive[]>([]);
  interface Session {
    timer: ReturnType<typeof setInterval> | null;
    pushed: boolean;
    /** Liveness pushes seen; a stale liveness query must not override one. */
    pushes: number;
    watches: Map<string, ReturnType<typeof createDirectoryWatch>>;
    unlisten: UnlistenFn[];
    ready: Promise<void>;
    /** Drop a start still deferred by the foreground gate. */
    cancelStart(): void;
  }
  interface PendingRefresh { owner: Session | null; task: Promise<void>; rerun: boolean }
  let active: Session | null = null;
  let pendingRefresh: PendingRefresh | null = null;
  const stopping = new Set<Promise<void>>();

  /**
   * Coalesce concurrent refreshes into one read, plus one trailing re-read when
   * another request arrives mid-flight: that request may announce a change the
   * in-flight read started too early to observe, and with a slow backstop poll
   * a dropped change would stay invisible for the full interval.
   */
  function refresh(): Promise<void> {
    const owner = active;
    if (pendingRefresh?.owner === owner) {
      pendingRefresh.rerun = true;
      return pendingRefresh.task;
    }
    const pending: PendingRefresh = { owner, task: Promise.resolve(), rerun: false };
    pending.task = (async () => {
      try {
        do {
          pending.rerun = false;
          const result = await listDrives();
          if (active === owner && result.ok) drives = result.data;
        } while (pending.rerun && active === owner);
      } finally {
        if (pendingRefresh === pending) pendingRefresh = null;
      }
    })();
    pendingRefresh = pending;
    return pending.task;
  }

  function schedule(session: Session, pushed: boolean) {
    if (session.timer !== null && session.pushed === pushed) return;
    if (session.timer !== null) clearInterval(session.timer);
    session.pushed = pushed;
    session.timer = setInterval(
      () => { void refresh().catch(console.error); },
      pushed ? PUSHED_POLL_INTERVAL_MS : UNPUSHED_POLL_INTERVAL_MS,
    );
  }

  async function subscribe(session: Session): Promise<void> {
    const unlistenDirs = await listen<{ path: string }>("directory-changed", (event) => {
      if (active === session && session.watches.has(event.payload.path)) {
        void refresh().catch(console.error);
      }
    });
    if (active !== session) { unlistenDirs(); return; }
    session.unlisten.push(unlistenDirs);
    const unlistenDrives = await listen<DrivesChanged>(DRIVES_CHANGED_EVENT, (event) => {
      if (active !== session) return;
      // Only the UDisks monitor reports liveness; other sources just refresh.
      const { live } = event.payload ?? {};
      if (typeof live === "boolean") {
        session.pushes++;
        schedule(session, live);
      }
      void refresh().catch(console.error);
    });
    if (active !== session) { unlistenDrives(); return; }
    session.unlisten.push(unlistenDrives);
    // A push before the listener existed was missed: learn the current
    // liveness, then re-read once so a change in that gap is not left to the
    // slow backstop.
    const pushes = session.pushes;
    const live = await driveUpdatesLive();
    if (active !== session || session.pushes !== pushes) return;
    schedule(session, live);
    if (live) await refresh();
  }

  /** The session's feeds: first read, mount-base watches, pushes and poll. */
  async function begin(session: Session): Promise<void> {
    schedule(session, false);
    await refresh();
    if (active !== session) return;
    for (const base of detectMountBases()) {
      if (active !== session) return;
      const watch = createDirectoryWatch();
      session.watches.set(base, watch);
      try { await watch.update(base); } catch { /* Mount base may not exist. */ }
    }
    if (active !== session) return;
    try { await subscribe(session); } catch { /* Browser mode relies on polling. */ }
  }

  /**
   * Start this page's drive feeds. A parked warm window reads the list once
   * and defers the feeds (re-read, watches, pushes, poll) until it is
   * activated (#931); the returned promise settles once they have started, or
   * once the session stops before that.
   */
  function startPolling(): Promise<void> {
    if (active) return active.ready;
    const session: Session = {
      timer: null, pushed: false, pushes: 0,
      watches: new Map(), unlisten: [], ready: Promise.resolve(), cancelStart: () => {},
    };
    active = session;
    // A parked page still reads the list once, so a claimed window is revealed
    // with its drives; only the ongoing feeds wait for the foreground. Windows
    // enumerates drives through PowerShell, far too slow to await on reveal.
    if (!foreground.isForeground) void refresh().catch(console.error);
    session.ready = new Promise<void>((resolve) => {
      const cancel = foreground.whenForeground(() => begin(session).finally(resolve));
      session.cancelStart = () => { cancel(); resolve(); };
    });
    return session.ready;
  }

  async function stopPolling(): Promise<void> {
    const session = active;
    if (session) {
      active = null;
      session.cancelStart();
      if (session.timer !== null) clearInterval(session.timer);
      const task = (async () => {
        try {
          for (const unlisten of session.unlisten) {
            try { unlisten(); } catch (error) { console.error(error); }
          }
        } finally {
          // Start cleanup before waiting for startup: a delayed watch is already
          // represented by its owner and must drain its acquisition first.
          await Promise.allSettled([
            session.ready,
            ...[...session.watches.values()].map((watch) => watch.destroy()),
          ]);
        }
      })();
      stopping.add(task);
      void task.finally(() => stopping.delete(task)).catch(() => {});
    }
    await Promise.all([...stopping]);
  }

  return {
    get list() {
      return drives;
    },
    get removable() {
      return drives.filter((d) => d.kind === "removable" || d.kind === "unknown");
    },
    /** Cloud / remote shortcuts eligible for the dedicated sidebar section. */
    get cloud() {
      return sidebarCloudDrives(drives);
    },
    /**
     * Normalised mount roots of currently-mounted removable drives (same
     * normalisation as mountedRoots). Used to detect when a pane is sitting on
     * a removable drive so it can show a "drive removed" state once it ejects.
     * Unmounted volumes have no root and never count.
     */
    get removableRoots() {
      return mountRoots(drives.filter((d) => d.kind === "removable" || d.kind === "unknown"));
    },
    /**
     * Set of currently-mounted drive roots, lowercased and normalised, used to
     * hide Recent locations that live on an ejected drive. On Windows a root is
     * the drive letter prefix (e.g. "e:"); elsewhere it's the mount path.
     */
    get mountedRoots() {
      return new Set(mountRoots(drives));
    },
    refresh,
    startPolling,
    stopPolling,
  };
}

export const drivesStore = createDrivesStore(pageForeground);
