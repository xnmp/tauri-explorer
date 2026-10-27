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

export function videoClickAction(control: "surface" | "button" | "message"): VideoAction | null {
  return control === "surface" ? "fullscreen" : null;
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

export interface VideoCodecInfo { container: string | null; videoCodec: string | null; audioCodec: string | null; }

/** Unsupported-state message; names the codec when the probe found one. */
export function unsupportedVideoMessage(info: VideoCodecInfo | null): string {
  const parts = [info?.videoCodec && `video: ${info.videoCodec}`, info?.audioCodec && `audio: ${info.audioCodec}`].filter(Boolean);
  const detail = parts.length ? `Codec — ${parts.join(", ")}${info?.container ? ` (${info.container})` : ""}.` : "Codec could not be determined.";
  return `This video format or codec is not supported by your system. ${detail}`;
}

/** MediaError codes 3 (decode) and 4 (source not supported) mean the codec cannot be played; others are load failures. */
export function classifyVideoFailure(code: number | undefined): "unsupported" | "unavailable" {
  return code === 3 || code === 4 ? "unsupported" : "unavailable";
}

/** The player's sound state as the media element holds it: mute keeps the volume. */
export interface VolumeState { readonly volume: number; readonly muted: boolean; }
export type VolumeLevel = "muted" | "low" | "high";

/** Unmuting from zero with no remembered audible volume lands here (#1425). */
export const DEFAULT_UNMUTE_VOLUME = 0.5;
/** One arrow-key or wheel notch. */
export const VOLUME_STEP = 0.05;
const LOW_VOLUME_BELOW = 0.5;

function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** What is actually heard: a muted player, or one at zero volume, is silent. */
export function audibleVolume(state: VolumeState): number {
  return state.muted ? 0 : clampVolume(state.volume);
}

export function volumeLevel(state: VolumeState): VolumeLevel {
  const audible = audibleVolume(state);
  return audible <= 0 ? "muted" : audible < LOW_VOLUME_BELOW ? "low" : "high";
}

/** Slider value text: "Muted" or a whole percentage. */
export function volumeText(state: VolumeState): string {
  const audible = audibleVolume(state);
  return audible <= 0 ? "Muted" : `${Math.round(audible * 100)}%`;
}

/** The last audible volume, carried forward so unmuting from zero can restore it. */
export function rememberAudible(previous: number, state: VolumeState): number {
  const audible = audibleVolume(state);
  return audible > 0 ? audible : previous;
}

/** Sets a volume; any audible value unmutes, as dragging a muted player's slider does. */
export function setVolumeTo(state: VolumeState, value: number): VolumeState {
  const volume = clampVolume(value);
  return { volume, muted: volume > 0 ? false : state.muted };
}

/** Steps from the element's volume, so a muted player resumes near its previous level. */
export function stepVolume(state: VolumeState, delta: number): VolumeState {
  return setVolumeTo(state, clampVolume(state.volume) + delta);
}

/**
 * The speaker button: silence an audible player by muting (keeping its volume),
 * or make a silent one audible again at its own volume, the last audible volume,
 * or a default when there has never been one.
 */
export function toggleMuted(state: VolumeState, lastAudible: number): VolumeState {
  if (audibleVolume(state) > 0) return { volume: clampVolume(state.volume), muted: true };
  const restore = [state.volume, lastAudible, DEFAULT_UNMUTE_VOLUME].map(clampVolume).find(value => value > 0)!;
  return { volume: restore, muted: false };
}

/** Wheel over the volume control: one step per event, up raises; horizontal-only wheels do nothing. */
export function wheelVolumeDelta(deltaY: number): number {
  return !Number.isFinite(deltaY) || deltaY === 0 ? 0 : deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP;
}
