<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { loadVideoPreview } from "$lib/api/video-preview";
  import { openFile } from "$lib/api/open";
  import { extractError } from "$lib/api/common";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { keybindingsStore } from "$lib/state/keybindings.svelte";
  import { mediaTime, seekTime, videoKeyAction } from "$lib/domain/video-preview";
  import type { VideoSource } from "$lib/state/video-preview-lifetime";
  let { path, name, fullscreen, ontogglefullscreen }: {path:string;name:string;fullscreen:boolean;ontogglefullscreen:()=>void} = $props();
  let video = $state<HTMLVideoElement | null>(null);
  let source = $state<VideoSource | null>(null);
  let error = $state<string | null>(null);
  let ready = $state(false);
  let playing = $state(false);
  let current = $state(0);
  let duration = $state(0);
  let volume = $state(1);
  let muted = $state(false);
  // PreviewPane keys this component by the complete file revision.
  const job = untrack(() => loadVideoPreview(path));
  let disposed = false;
  job.promise.then(value => {
    if (disposed) value.release(); else source = value;
  }).catch(cause => { if (!disposed) error = extractError(cause); });
  onDestroy(() => {
    disposed = true;
    detachSource();
  });
  function detachSource() {
    if (video) {
      video.pause();
      if (video.hasAttribute("src")) { video.removeAttribute("src"); video.load(); }
    }
    source?.release();
    source = null;
    job.cancel();
  }
  function fail(message: string) {
    if (disposed) return;
    error ??= message;
    detachSource();
  }
  function sync() {
    if (!video || disposed) return;
    playing = !video.paused && !video.ended;
    current = video.currentTime;
    duration = Number.isFinite(video.duration) ? video.duration : 0;
    volume = video.volume;
    muted = video.muted;
    ready = video.readyState >= HTMLMediaElement.HAVE_METADATA;
  }
  async function togglePlay() {
    if (!video || !ready || error) return;
    if (!video.paused) { video.pause(); return; }
    try { await video.play(); }
    catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      fail(`Cannot start playback: ${extractError(cause)}`);
    }
  }
  function seek(time: number) { if (video && ready) video.currentTime = seekTime(time,duration); }
  function setVolume(value: number) { if (video) {video.volume = Math.max(0,Math.min(1,value));if (value > 0) video.muted = false;} }
  function toggleMute() { if (video) video.muted = !video.muted; }
  function onKey(event: KeyboardEvent) {
    if (dialogStore.hasModalOpen) return;
    const target = event.target as HTMLElement;
    const action = videoKeyAction(event,target.tagName === "INPUT" ? "range" : target.closest("button") ? "button" : "surface", keybindingsStore.trackedMetaHeld);
    if (!action) return;
    event.preventDefault();
    if (!ready || error) return;
    switch (action) {
      case "consume": break;
      case "toggle-play": void togglePlay(); break;
      case "seek-back": seek(current-5); break;
      case "seek-forward": seek(current+5); break;
      case "start": seek(0); break;
      case "end": seek(duration); break;
      case "volume-up": setVolume(volume+0.05); break;
      case "volume-down": setVolume(volume-0.05); break;
      case "mute": toggleMute(); break;
      case "fullscreen": ontogglefullscreen(); break;
    }
  }
  function mediaFailed() {
    if (disposed) return;
    fail(video?.error?.code === MediaError.MEDIA_ERR_DECODE || video?.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
      ? "This video format or codec is not supported by your system."
      : "Cannot load this video. It may have changed or become unavailable.");
  }
  async function openExternal() {
    const result = await openFile(path);
    if (!result.ok && !disposed) error = `Cannot open video: ${result.error}`;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- focusable media group owns playback shortcuts; its controls retain native input behavior. -->
<div class="video-preview" role="group" aria-label="Video player for {name}" tabindex="0" onkeydown={onKey}>
  <div class="video-stage" class:failed={!!error}>
    <video bind:this={video} src={source?.url} preload="metadata" playsinline aria-label="Video preview of {name}"
      onloadedmetadata={sync} onloadeddata={sync} ondurationchange={sync} ontimeupdate={sync}
      onplay={sync} onpause={sync} onended={sync} onvolumechange={sync} onseeked={sync} onerror={mediaFailed}>
      <track kind="captions" />
    </video>
    {#if error}
      <div class="video-message" role="status"><span>{error}</span><button type="button" onclick={openExternal}>Open externally</button></div>
    {:else if !ready}
      <div class="video-message" role="status">Loading video…</div>
    {/if}
  </div>
  <div class="video-controls">
    <div class="transport">
      <button type="button" aria-label={playing ? "Pause video" : "Play video"} title={playing ? "Pause (Space)" : "Play (Space)"}
        disabled={!ready || !!error} onclick={togglePlay}>{playing ? "Ⅱ" : "▶"}</button>
      <span class="video-time" aria-label="Video time">{mediaTime(current)} / {mediaTime(duration)}</span>
      <button type="button" class="fullscreen-button" aria-label={fullscreen ? "Exit video fullscreen" : "View video fullscreen"}
        title="Fullscreen (F)" onclick={ontogglefullscreen}>⛶</button>
    </div>
    <input class="seek" type="range" aria-label="Seek video" aria-valuetext="{mediaTime(current)} of {mediaTime(duration)}"
      min="0" max={duration || 1} step="0.1" value={current} disabled={!ready || duration <= 0 || !!error}
      oninput={event => seek(event.currentTarget.valueAsNumber)} />
    <div class="sound">
      <button type="button" aria-label={muted ? "Unmute video" : "Mute video"} title="Mute (M)" disabled={!ready || !!error} onclick={toggleMute}>{muted ? "Muted" : "Sound"}</button>
      <input type="range" aria-label="Video volume" min="0" max="1" step="0.05" value={volume} disabled={!ready || !!error}
        oninput={event => setVolume(event.currentTarget.valueAsNumber)} />
    </div>
  </div>
</div>

<style>
  .video-preview {display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:auto;container-type:inline-size;}
  .video-stage {position:relative;flex:1;min-height:24px;overflow:hidden;background:var(--background-solid);}
  .video-stage.failed {flex-shrink:0;min-height:96px;}
  video {display:block;width:100%;height:100%;object-fit:contain;}
  .video-message {position:absolute;inset:0;display:flex;align-items:center;justify-content:safe center;flex-direction:column;gap:8px;padding:12px;overflow:auto;background:var(--background-solid);color:var(--text-secondary);text-align:center;font-size:var(--font-size-caption);}
  .video-controls {display:grid;flex-shrink:0;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;padding:4px 8px;border-top:1px solid var(--divider);background:var(--background-solid);}
  .transport {grid-column:1 / -1;display:flex;align-items:center;gap:8px;min-width:0;}
  .video-time {font-size:var(--font-size-caption);font-variant-numeric:tabular-nums;white-space:nowrap;}
  .fullscreen-button {margin-left:auto;}
  .seek {min-width:0;width:100%;}
  .sound {display:flex;align-items:center;gap:4px;}
  .sound input {width:64px;}
  button {min-width:28px;min-height:28px;border:0;border-radius:4px;padding:0 6px;background:transparent;color:var(--text-secondary);font:inherit;font-size:var(--font-size-caption);cursor:pointer;}
  button:hover:enabled {background:var(--subtle-fill-tertiary);color:var(--text-primary);}
  button:disabled {opacity:0.4;cursor:default;}
  button:focus-visible,input:focus-visible,.video-preview:focus-visible {outline:2px solid var(--focus-stroke-outer);outline-offset:-2px;}
  input {accent-color:var(--accent);}
  @container (min-width:440px) {
    .video-controls {grid-template-columns:auto minmax(0,1fr) auto;}
    .transport {grid-column:auto;}
  }
</style>
