/** Media input policy and display values, independent of the DOM/player. */
export type VideoAction =
  | "consume" | "toggle-play" | "seek-back" | "seek-forward"
  | "volume-up" | "volume-down" | "start" | "end" | "mute" | "fullscreen";

const actions: Readonly<Record<string, VideoAction>> = {
  " ": "toggle-play", Enter: "toggle-play", k: "toggle-play",
  ArrowLeft: "seek-back", ArrowRight: "seek-forward",
  ArrowUp: "volume-up", ArrowDown: "volume-down",
  Home: "start", End: "end", m: "mute", f: "fullscreen",
};

export function videoKeyAction(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey"> & { repeat?: boolean },
  control: "surface" | "button" | "range",
  trackedMetaHeld = false,
): VideoAction | null {
  if (event.ctrlKey || event.altKey || event.metaKey || trackedMetaHeld) return null;
  if (control === "range") return null;
  if (control === "button" && (event.key === " " || event.key === "Enter")) return null;
  const action = actions[event.key] ?? actions[event.key.toLowerCase()] ?? null;
  // A held toggle remains media-owned but does not repeatedly change state.
  return event.repeat && (action === "toggle-play" || action === "mute" || action === "fullscreen")
    ? "consume" : action;
}

export function mediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const value = Math.floor(seconds);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  const rest = String(value % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function seekTime(time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(0, Math.min(duration, Number.isFinite(time) ? time : 0));
}
