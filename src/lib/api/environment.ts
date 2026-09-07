/** Process and user-directory queries plus startup diagnostics. */
import { invoke, extractError, type ApiResult } from "./common";

export async function getHomeDirectory(): Promise<ApiResult<string>> {
  try { return { ok: true, data: await invoke<string>("get_home_directory") }; }
  catch (err) { return { ok: false, error: extractError(err) }; }
}

export async function getLaunchCwd(): Promise<ApiResult<string>> {
  try { return { ok: true, data: await invoke<string>("get_launch_cwd") }; }
  catch (err) { return { ok: false, error: extractError(err) }; }
}

export function getLogDir(): Promise<string> {
  return invoke<string>("get_log_dir");
}

export function logStartupTiming(summary: string): Promise<void> {
  return invoke<void>("log_startup_timing", { summary });
}
