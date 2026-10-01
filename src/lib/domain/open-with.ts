import type { FileEntry } from "./file";

export interface OpenWithApplication {
  id: string;
  name: string;
}

export function openWithUnavailableReason(entries: readonly FileEntry[], platform: "linux" | "windows" | "macos"): string | null {
  if (platform !== "linux") return "Open with is currently available on Linux";
  if (entries.length !== 1 || entries[0].kind !== "file") return "Select one regular file to choose an application";
  return null;
}
