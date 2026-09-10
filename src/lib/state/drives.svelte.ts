import { listDrives, type Drive } from "$lib/api/drives";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createDirectoryWatch } from "./directory-watch";
import { directoryKey } from "$lib/domain/path";

// Polling backstop. The fs-watcher subscription handles most eject/insert
// events but we still poll occasionally in case a mount point uses a base
// directory that wasn't yet watchable (e.g. /run/media/$USER not present).
const REFRESH_INTERVAL_MS = 1500;

const LINUX_MOUNT_BASES = (user: string) => [
  `/run/media/${user}`,
  `/media/${user}`,
  "/media",
  ...(
    typeof process !== "undefined" && process.env?.XDG_RUNTIME_DIR
      ? [`${process.env.XDG_RUNTIME_DIR}/gvfs`]
      : []
  ),
];

function detectMountBases(): string[] {
  if (typeof navigator === "undefined") return [];
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("linux")) {
    const user = (typeof process !== "undefined" && process.env?.USER) || "";
    if (!user) return ["/media"];
    return LINUX_MOUNT_BASES(user);
  }
  if (ua.includes("mac")) return ["/Volumes"];
  return [];
}

function createDrivesStore() {
  let drives = $state<Drive[]>([]);
  interface Session {
    timer: ReturnType<typeof setInterval>;
    watches: Map<string, ReturnType<typeof createDirectoryWatch>>;
    unlisten: UnlistenFn | null;
    ready: Promise<void>;
  }
  let active: Session | null = null;
  let pendingRefresh: { owner: Session | null; task: Promise<void> } | null = null;
  const stopping = new Set<Promise<void>>();

  function refresh(): Promise<void> {
    const owner = active;
    if (pendingRefresh?.owner === owner) return pendingRefresh.task;
    const task = Promise.resolve().then(listDrives).then((result) => {
      if (active === owner && result.ok) drives = result.data;
    }).finally(() => {
      if (pendingRefresh?.task === task) pendingRefresh = null;
    });
    pendingRefresh = { owner, task };
    return task;
  }

  function startPolling(): Promise<void> {
    if (active) return active.ready;
    const session: Session = {
      timer: setInterval(() => { void refresh().catch(console.error); }, REFRESH_INTERVAL_MS),
      watches: new Map(), unlisten: null, ready: Promise.resolve(),
    };
    active = session;
    session.ready = (async () => {
      await refresh();
      if (active !== session) return;
      for (const base of detectMountBases()) {
        if (active !== session) return;
        const watch = createDirectoryWatch();
        session.watches.set(base, watch);
        try { await watch.update(base); } catch { /* Mount base may not exist. */ }
      }
      if (active !== session) return;
      try {
        const unlisten = await listen<{ path: string }>("directory-changed", (event) => {
          if (active === session && session.watches.has(event.payload.path)) {
            void refresh().catch(console.error);
          }
        });
        if (active === session) session.unlisten = unlisten;
        else unlisten();
      } catch { /* Browser mode relies on polling. */ }
    })();
    return session.ready;
  }

  async function stopPolling(): Promise<void> {
    const session = active;
    if (session) {
      active = null;
      clearInterval(session.timer);
      const task = (async () => {
        try { session.unlisten?.(); } finally {
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
    /** Cloud / remote mounts (Google Drive, WSL home) for the dedicated section. */
    get cloud() {
      return drives.filter((d) => d.kind === "cloud");
    },
    /**
     * Normalised mount roots of currently-present removable drives (same
     * normalisation as mountedRoots). Used to detect when a pane is sitting on
     * a removable drive so it can show a "drive removed" state once it ejects.
     */
    get removableRoots() {
      return drives
        .filter((d) => d.kind === "removable" || d.kind === "unknown")
        .map((d) => directoryKey(d.path));
    },
    /**
     * Set of currently-mounted drive roots, lowercased and normalised, used to
     * hide Recent locations that live on an ejected drive. On Windows a root is
     * the drive letter prefix (e.g. "e:"); elsewhere it's the mount path.
     */
    get mountedRoots() {
      return new Set(drives.map((d) => directoryKey(d.path)));
    },
    refresh,
    startPolling,
    stopPolling,
  };
}

export const drivesStore = createDrivesStore();
