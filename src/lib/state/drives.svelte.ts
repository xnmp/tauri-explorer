import { listDrives, watchDirectory, unwatchDirectory, type Drive } from "$lib/api/files";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
  let timer: ReturnType<typeof setInterval> | null = null;
  let unlistenFs: UnlistenFn | null = null;
  const watchedBases = new Set<string>();

  async function refresh(): Promise<void> {
    const result = await listDrives();
    if (result.ok) {
      drives = result.data;
    }
  }

  async function startPolling(): Promise<void> {
    if (timer) return;
    // Claim the interval synchronously, before any await, so concurrent
    // startPolling calls bail immediately instead of leaking intervals.
    timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    await refresh();

    // Subscribe to fs events on the mount base directories so eject/insert
    // refreshes immediately rather than waiting for the next poll tick.
    for (const base of detectMountBases()) {
      try {
        await watchDirectory(base);
        watchedBases.add(base);
      } catch {
        // Base may not exist on this system — non-fatal.
      }
    }
    if (!unlistenFs) {
      // Outside Tauri the event system is unavailable and listen() rejects;
      // polling still covers drive changes there.
      try {
        unlistenFs = await listen<{ path: string }>("directory-changed", (e) => {
          if (watchedBases.has(e.payload.path)) {
            refresh();
          }
        });
      } catch {
        unlistenFs = null;
      }
    }
  }

  async function stopPolling(): Promise<void> {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (unlistenFs) {
      unlistenFs();
      unlistenFs = null;
    }
    for (const base of watchedBases) {
      try { await unwatchDirectory(base); } catch { /* ignore */ }
    }
    watchedBases.clear();
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
