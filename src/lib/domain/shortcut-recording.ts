import { parseShortcut } from "./keybinding-parser";

export const CHORD_TIMEOUT_MS = 1500;
export type RecordingMode = "single" | "chord";
export interface ShortcutRecording {
  readonly commandId: string;
  readonly mode: RecordingMode;
  readonly prefix: string | null;
}
export type RecordingStep =
  | { kind: "waiting"; recording: ShortcutRecording }
  | { kind: "complete"; commandId: string; shortcut: string }
  | { kind: "invalid" };

/** A captured step cannot accidentally contain a whole chord or a modifier alone. */
export function recordShortcutStep(recording: ShortcutRecording, step: string): RecordingStep {
  if (/\s/.test(step) || !parseShortcut(step)) return { kind: "invalid" };
  if (recording.mode === "chord" && recording.prefix === null) {
    return { kind: "waiting", recording: { ...recording, prefix: step } };
  }
  return { kind: "complete", commandId: recording.commandId,
    shortcut: recording.prefix ? `${recording.prefix} ${step}` : step };
}
