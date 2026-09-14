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
    const key = drive.device_id ?? drive.path;
    if (pending.has(key)) return;
    if (drive.path) { deps.navigate(drive.path); return; }
    if (!drive.device_id) { deps.error(`Cannot open ${drive.name}: no mountable volume available`); return; }
    pending.add(key);
    try {
      const result = await deps.mount(drive.device_id);
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
      pending.delete(key);
    }
  };
}
