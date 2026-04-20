import { listDrives, type Drive } from "$lib/api/files";

const REFRESH_INTERVAL_MS = 5000;

function createDrivesStore() {
  let drives = $state<Drive[]>([]);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    const result = await listDrives();
    if (result.ok) {
      drives = result.data;
    }
  }

  function startPolling(): void {
    if (timer) return;
    refresh();
    timer = setInterval(refresh, REFRESH_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    get list() {
      return drives;
    },
    get removable() {
      return drives.filter((d) => d.kind === "removable" || d.kind === "unknown");
    },
    refresh,
    startPolling,
    stopPolling,
  };
}

export const drivesStore = createDrivesStore();
