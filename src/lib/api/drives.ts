/** Native and cloud drive discovery. */
import { invoke, extractError, type ApiResult } from "./common";

export type DriveKind = "fixed" | "removable" | "network" | "cloud" | "unknown";
export type CloudProvider = "googledrive" | "wsl";
export interface Drive {
  name: string;
  /** Mount root and only navigable route; null for an unmounted volume. */
  path: string | null;
  /** Linux UDisks object identity, independent of the mount path. */
  deviceId?: string;
  kind: DriveKind;
  detail?: string;
  provider?: CloudProvider;
}

/** Backend event announcing that discovered drives, or their liveness, changed. */
export const DRIVES_CHANGED_EVENT = "drives-changed";
export interface DrivesChanged {
  /**
   * Set only by the Linux UDisks2 monitor, the sole liveness reporter: true
   * while its subscription pushes changes. Other change sources (mount table,
   * GVfs) omit it, so they never alter the poll cadence.
   */
  live?: boolean;
}

export async function listDrives(): Promise<ApiResult<Drive[]>> {
  try { return { ok: true, data: await invoke<Drive[]>("list_drives") }; }
  catch (err) { return { ok: false, error: extractError(err) }; }
}

/** Whether the backend currently pushes drive changes; otherwise poll for them. */
export async function driveUpdatesLive(): Promise<boolean> {
  try { return await invoke<boolean>("drive_updates_live"); }
  catch { return false; }
}

export async function mountDrive(deviceId: string): Promise<ApiResult<string>> {
  try { return { ok: true, data: await invoke<string>("mount_drive", { deviceId }) }; }
  catch (err) { return { ok: false, error: extractError(err) }; }
}
