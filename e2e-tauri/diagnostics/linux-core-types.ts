/** Native crash artifacts are evidence, never a replacement for the smoke result. */
export interface LinuxCoreRecord {
  core: string;
  executable: string | null;
  transcript: string | null;
  error: string | null;
}

export interface LinuxCoreCollectorOptions {
  directory: string;
  captureDirectory?: string;
  captureTimeoutMs?: number;
  executables: Readonly<Record<string, string>>;
  debug: (executable: string, core: string) => Promise<string>;
}
