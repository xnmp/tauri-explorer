import type { Drive } from "$lib/api/drives";
import type { ApiResult } from "$lib/api/common";

/** Sidebar action boundary: a volume identity is never a navigation path. */
export function createDriveOpener(deps: {
  mount: (deviceId: string) => Promise<ApiResult<string>>;
  navigate: (path: string) => void;
  error: (message: string) => void;
  refresh: () => Promise<void>;
}) {
  const pending = new Set<string>();
  return async (drive: Drive): Promise<void> => {
    if (drive.path !== null) { deps.navigate(drive.path); return; }
    const deviceId = drive.deviceId;
    if (!deviceId) { deps.error(`Cannot open ${drive.name}: no mountable volume available`); return; }
    if (pending.has(deviceId)) return;
    pending.add(deviceId);
    try {
      const result = await deps.mount(deviceId);
      if (!result.ok) { deps.error(`Cannot open ${drive.name}: ${result.error}`); return; }
      if (!result.data.startsWith("/") || result.data.includes("\0")) {
        deps.error(`Cannot open ${drive.name}: storage service returned an invalid mount path`);
        return;
      }
      deps.navigate(result.data);
      await deps.refresh();
    } catch (error) {
      deps.error(`Cannot open ${drive.name}: ${String(error)}`);
    } finally {
      pending.delete(deviceId);
    }
  };
}
