import { invoke, isTauri } from "./common";
import { listen } from "@tauri-apps/api/event";
import { validNativeSnapshot, type NativeJobSnapshot } from "$lib/domain/native-plugin-jobs";
export async function snapshotPluginJobs(): Promise<NativeJobSnapshot> {
  const value = await invoke<unknown>("plugin_jobs_snapshot", {});
  if (!validNativeSnapshot(value)) throw new Error("Native job presentation is unavailable or malformed. Update the host or reload Background Operations.");
  return value;
}
export const cancelPluginJob = (jobKey: string) => invoke<void>("plugin_job_cancel", { jobKey });
export const dismissPluginJob = (jobKey: string) => invoke<void>("plugin_job_dismiss", { jobKey });
export const resumePluginJob = (jobKey: string) => invoke<void>("plugin_job_resume", { jobKey });
export async function watchPluginJobs(receive: (value: unknown) => void): Promise<() => void> {
  if (isTauri()) return listen("plugin-jobs:changed", (event) => receive(event.payload));
  const callback = (event: Event) => receive((event as CustomEvent).detail);
  window.addEventListener("plugin-jobs:changed", callback);
  return () => window.removeEventListener("plugin-jobs:changed", callback);
}
