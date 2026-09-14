/** Native and cloud drive discovery. */
import { invoke, extractError, type ApiResult } from "./common";

export type DriveKind = "fixed" | "removable" | "network" | "cloud" | "unknown";
export type CloudProvider = "googledrive" | "wsl";
export interface Drive {
  name: string;
  /** Empty for unmounted volumes; never navigate until mounting succeeds. */
  path: string;
  /** Linux UDisks object identity, independent of the mount path. */
  device_id?: string;
  kind: DriveKind;
  detail?: string;
  provider?: CloudProvider;
}

export async function listDrives(): Promise<ApiResult<Drive[]>> {
  try { return { ok: true, data: await invoke<Drive[]>("list_drives") }; }
  catch (err) { return { ok: false, error: extractError(err) }; }
}

export async function mountDrive(deviceId: string): Promise<ApiResult<string>> {
  try { return { ok: true, data: await invoke<string>("mount_drive", { deviceId }) }; }
  catch (err) { return { ok: false, error: extractError(err) }; }
}
