import fs from "node:fs";
import path from "node:path";
import { collectNativeProcessEvidence, type NativeProcessEvidence } from "./fresh-window-diagnostics";

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

export interface TerminalKeyProbeActions {
  /** The only renderer read around the potentially session-losing key command. */
  captureProbe: () => Promise<TerminalKeyProbeSnapshot | { error: string }>;
  sendKey: () => Promise<void>;
  waitForDelivery: () => Promise<unknown>;
}

export interface TerminalKeyProbeDiagnosticOptions {
  applicationPath: string;
  directory: string;
  now?: () => number;
  collectNative?: () => NativeProcessEvidence | { error: string };
  write?: (record: TerminalKeyOwnershipDiagnostics, directory: string) => string | null;
}

/**
 * Preserve the native command boundary: one renderer-side sample before
 * Ctrl+Q, then only observation-safe process evidence if WebDriver cannot
 * observe the raw PTY result. This deliberately performs no retry or
 * renderer read after a failed delivery.
 */
export async function runTerminalKeyProbeDiagnostics(
  actions: TerminalKeyProbeActions,
  options: TerminalKeyProbeDiagnosticOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const collectNative = options.collectNative
    ?? (() => collectNativeProcessEvidence({ applicationPath: options.applicationPath }));
  const write = options.write ?? writeTerminalKeyOwnershipDiagnostics;
  const beforeKey = {
    issue: 709 as const,
    phase: "before-key" as const,
    capturedAt: now(),
    probe: await actions.captureProbe(),
    native: collectNative(),
  };
  write(beforeKey, options.directory);
  await actions.sendKey();

  try {
    await actions.waitForDelivery();
  } catch (error) {
    const failure = {
      ...beforeKey,
      phase: "probe-failed" as const,
      capturedAt: now(),
      native: collectNative(),
      error: String(error),
    };
    const artifact = write(failure, options.directory);
    console.error("[terminal-key-diagnostics]", JSON.stringify({ artifact, failure }));
    throw error;
  }
}
