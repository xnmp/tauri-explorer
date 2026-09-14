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
