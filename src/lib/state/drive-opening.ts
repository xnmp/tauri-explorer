import type { Drive } from "$lib/api/drives";
import type { ApiResult } from "$lib/api/common";

/** Sidebar action boundary: a volume identity is never a navigation path. */
export function createDriveOpener(deps: {
  mount: (deviceId: string) => Promise<ApiResult<string>>;
  navigate: (path: string) => void;
  error: (message: string) => void;
  refresh: () => Promise<void>;
}) {
  return async (drive: Drive): Promise<void> => {
    deps.navigate(drive.path);
  };
}
