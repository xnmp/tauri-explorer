import { CHORD_TIMEOUT_MS, recordShortcutStep, type RecordingMode, type ShortcutRecording } from "$lib/domain/shortcut-recording";

/** Own the recorder deadline separately from the component and runtime dispatcher. */
export function createShortcutRecorder(onChange: (value: ShortcutRecording | null) => void, onTimeout: () => void) {
  let recording: ShortcutRecording | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  const publish = (value: ShortcutRecording | null) => { recording = value; onChange(value); };
  function cancel(): void {
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    publish(null);
  }
  return {
    start(commandId: string, mode: RecordingMode): void {
      cancel();
      publish({ commandId, mode, prefix: null });
    },
    capture(step: string): { commandId: string; shortcut: string } | null {
      if (!recording) return null;
      const result = recordShortcutStep(recording, step);
      if (result.kind === "waiting") {
        publish(result.recording);
        deadline = setTimeout(() => { cancel(); onTimeout(); }, CHORD_TIMEOUT_MS);
        return null;
      }
      cancel();
      return result.kind === "complete" ? { commandId: result.commandId, shortcut: result.shortcut } : null;
    },
    cancel,
  };
}
