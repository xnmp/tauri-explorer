import fs from "node:fs";
import path from "node:path";
import type { NativeProcessEvidence } from "./fresh-window-diagnostics";

/** DOM-only state observed around the native Ctrl+Q probe. */
export interface TerminalKeyProbeSnapshot {
  terminalText: string | null;
  activeElement: { tag: string; classes: string } | null;
  terminalDisplayed: boolean;
  modalText: string | null;
}

/**
 * Artifact retained when WebDriver does not deliver Ctrl+Q to the raw PTY
 * probe. The pre-key snapshot distinguishes focus/event delivery from a
 * renderer or driver loss without issuing another WebDriver command after the
 * failed probe.
 */
export interface TerminalKeyOwnershipDiagnostics {
  issue: 709;
  phase: "before-key" | "probe-failed";
  capturedAt: number;
  probe: TerminalKeyProbeSnapshot | { error: string };
  native: NativeProcessEvidence | { error: string };
  error?: string;
}

/**
 * Persist a diagnostic as a best-effort native-run artifact. The caller keeps
 * the actual probe assertion authoritative, so an unwritable log directory
 * never turns a passing run into a failure or hides the original failure.
 */
export function writeTerminalKeyOwnershipDiagnostics(
  record: TerminalKeyOwnershipDiagnostics,
  directory: string,
): string | null {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const destination = path.join(directory, `${record.capturedAt}-${record.phase}.json`);
    fs.writeFileSync(destination, `${JSON.stringify(record, null, 2)}\n`);
    return destination;
  } catch {
    return null;
  }
}
