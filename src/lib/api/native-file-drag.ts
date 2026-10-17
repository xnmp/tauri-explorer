import { Channel } from "@tauri-apps/api/core";
import { invoke } from "./common";
import type { CallbackPayload, Options } from "@crabnebula/tauri-plugin-drag";
import type { DragData } from "$lib/state/drag.svelte";

/** The host binds the source to native events before either IPC channel runs. */
export function startFileDrag(options: Options, onEvent: (result: CallbackPayload) => void, source: DragData | null): Promise<void> {
  const channel = new Channel<CallbackPayload>();
  channel.onmessage = onEvent;
  return invoke("start_file_drag", { item: options.item, image: options.icon, source, onEvent: channel });
}

export type NativeFileDragEvent = (
  | { type: "enter" | "drop"; paths: string[]; position: { x: number; y: number }; source: DragData | null }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "leave" }
) & { copyModifier?: boolean | null; observedAt?: number; observationClock?: string;
  /** Captured at the platform event, independently of renderer completion IPC. */
  completedGestureSequence?: number };

/** Exact HTML5 source retirement also fences a late native adoption command. */
export function endHtml5FileDrag(source: DragData, reason: "ended" | "owner-disposed"): Promise<void> {
  return invoke("end_html5_file_drag", { source, reason });
}
