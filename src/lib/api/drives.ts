/** Native and cloud drive discovery. */
import { invoke, extractError, type ApiResult } from "./common";

export type DriveKind = "fixed" | "removable" | "network" | "cloud" | "unknown";
export type CloudProvider = "googledrive" | "wsl";
export interface Drive {
  name: string;
  path: string;
  kind: DriveKind;
  detail?: string;
  provider?: CloudProvider;
}

export async function listDrives(): Promise<ApiResult<Drive[]>> {
  try { return { ok: true, data: await invoke<Drive[]>("list_drives") }; }
  catch (err) { return { ok: false, error: extractError(err) }; }
}
