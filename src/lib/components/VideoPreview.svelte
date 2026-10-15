<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { loadVideoAudio, loadVideoPreview, NoVideoAudio, probeVideoCodec, saveVideoCopy } from "$lib/api/video-preview";
  import { openFile } from "$lib/api/open";
  import { extractError } from "$lib/api/common";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { keybindingsStore } from "$lib/state/keybindings.svelte";
  import { classifyVideoFailure, unsupportedVideoMessage, mediaTime, seekTime, videoClickAction, videoKeyAction } from "$lib/domain/video-preview";
  import type { VideoLoadJob, VideoSource } from "$lib/state/video-preview-lifetime";
  import { followVideo, needsCompanionAudio } from "$lib/state/video-companion-audio";
  import { isMac, isWindows } from "$lib/domain/platform";
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
  // Companion audio when WebKitGTK dropped an undecodable audio track (#1171).
  let audio = $state<HTMLAudioElement | null>(null);
  let companion = $state<VideoSource | null>(null);
  let audioNote = $state<"preparing" | { error: string } | null>(null);
  let audioJob: VideoLoadJob | null = null;
  const platform = isWindows ? "windows" : isMac ? "macos" : "linux";
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
  function detachAudio() {
    if (audio) {
      audio.pause();
      if (audio.hasAttribute("src")) { audio.removeAttribute("src"); audio.load(); }
    }
    companion?.release();
    companion = null;
    audioJob?.cancel();
    if (audioNote === "preparing") audioNote = null;
  }
  /** Once the pipeline can play, a missing native audio track asks for companion audio. */
  function checkAudio() {
    if (!video || disposed || audioJob || error || !needsCompanionAudio(video, platform)) return;
    const job = audioJob = loadVideoAudio(path);
    audioNote = "preparing";
    job.promise.then(value => {
      if (disposed || audioJob !== job || !video || !needsCompanionAudio(video, platform)) { value.release(); return; }
      companion = value;
      audioNote = null;
    }).catch(cause => {
      if (disposed || audioJob !== job || audioNote !== "preparing") return;
      audioNote = cause instanceof NoVideoAudio ? null : { error: extractError(cause) };
    });
  }
  function audioFailed() {
    if (disposed || !companion) return;
    detachAudio();
    audioNote = { error: "The decoded audio could not be played" };
  }
  $effect(() => {
    // A native track that appears later wins; never play both.
    const tracks = (video as (HTMLVideoElement & { audioTracks?: EventTarget }) | null)?.audioTracks;
    if (!tracks?.addEventListener) return;
    tracks.addEventListener("addtrack", detachAudio);
    return () => tracks.removeEventListener("addtrack", detachAudio);
  });
  $effect(() => {
    if (!video || !audio || !companion) return;
    return followVideo(video, audio);
  });
  function detachSource() {
    detachAudio();
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
    if (dialogStore.isInputBlocked(event, windowTabsManager.activePaneId)) return;
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
  let unsupported = $state(false);
  let saveError = $state<string | null>(null);
  async function mediaFailed() {
    if (disposed) return;
    if (classifyVideoFailure(video?.error?.code) === "unavailable") {
      fail("Cannot load this video. It may have changed or become unavailable.");
      return;
    }
    unsupported = true;
    fail(unsupportedVideoMessage(null));
    const info = await probeVideoCodec(path);
    if (!disposed && info) error = unsupportedVideoMessage(info);
  }
  async function download() {
    saveError = null;
    try { await saveVideoCopy(path, name); }
    catch (cause) { if (!disposed) saveError = `Cannot save copy: ${extractError(cause)}`; }
  }
  function onStageClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const control = target instanceof HTMLVideoElement ? "surface" : target.closest("button") ? "button" : "message";
    if (videoClickAction(control) === "fullscreen") ontogglefullscreen();
  }
  async function openExternal() {
    const result = await openFile(path);
    if (!result.ok && !disposed) error = `Cannot open video: ${result.error}`;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- focusable media group owns playback shortcuts; its controls retain native input behavior. -->
<div class="video-preview" role="group" aria-label="Video player for {name}" tabindex="0" onkeydown={onKey}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- pointer shortcut; the focusable group's F key and the fullscreen button are the keyboard path. -->
  <div class="video-stage" class:failed={!!error} onclick={onStageClick}>
    <video bind:this={video} src={source?.url} preload="metadata" playsinline aria-label="Video preview of {name}"
      onloadedmetadata={sync} onloadeddata={sync} ondurationchange={sync} ontimeupdate={sync}
      oncanplay={checkAudio} onplaying={checkAudio} onplay={sync} onpause={sync} onended={sync} onvolumechange={sync} onseeked={sync} onerror={mediaFailed}>
      <track kind="captions" />
    </video>
    <audio bind:this={audio} src={companion?.url} preload="auto" onerror={audioFailed}></audio>
    {#if error}
      <div class="video-message" role="status"><span>{error}</span>{#if saveError}<span class="save-error">{saveError}</span>{/if}{#if unsupported}<button type="button" onclick={download}>Download</button>{/if}<button type="button" onclick={openExternal}>Open externally</button></div>
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
      {#if audioNote}
        <span class="audio-note" role="status" title={audioNote === "preparing" ? "Decoding this video's audio track" : audioNote.error}>
          {audioNote === "preparing" ? "Preparing audio…" : "No audio"}</span>
      {/if}
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
  .audio-note {font-size:var(--font-size-caption);color:var(--text-secondary);white-space:nowrap;}
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
