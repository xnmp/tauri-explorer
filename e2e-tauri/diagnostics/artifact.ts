/**
 * Shared, best-effort persistence for native-suite diagnostic artifacts.
 *
 * Every investigation module in this directory records evidence the same way:
 * capture, name the file without trusting caller strings, persist, and never
 * let the persistence step replace the failure it documents. Keep that policy
 * here so each investigation only describes what it captures.
 *
 * Not itself scaffolding for one issue: retire it when the last module in
 * `e2e-tauri/diagnostics/` that imports it is deleted.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Root for native diagnostics; CI uploads `e2e-tauri/logs/` with the WDIO logs. */
export const NATIVE_LOG_DIRECTORY = path.resolve("e2e-tauri", "logs");

/**
 * Directory for one investigation's JSON records. `TAURI_NATIVE_DIAGNOSTICS_DIR`
 * redirects every investigation, which keeps unit runs out of the checkout.
 */
export function diagnosticsDirectory(investigation: string): string {
  return process.env.TAURI_NATIVE_DIAGNOSTICS_DIR
    ?? path.join(NATIVE_LOG_DIRECTORY, investigation);
}

/**
 * `<timestamp>-<digest>-<suffix>.json` for a record keyed by an untrusted
 * string such as a window label. Per ADR 0021 the string is digested rather
 * than used as a path component; keep it verbatim inside the JSON body.
 */
export function hashedArtifactName(timestamp: number, untrustedKey: string, suffix: string): string {
  const digest = createHash("sha256").update(untrustedKey).digest("hex").slice(0, 12);
  return `${timestamp}-${digest}-${suffix}.json`;
}

/**
 * Write `record` as pretty JSON into `directory/fileName`, creating the
 * directory. Returns the written path, or `null` when writing failed: a
 * diagnostic must never mask the outcome it documents.
 */
export function writeDiagnosticArtifact(
  directory: string,
  fileName: string,
  record: unknown,
): string | null {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, fileName);
    fs.writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`);
    return destination;
  } catch {
    return null;
  }
}
