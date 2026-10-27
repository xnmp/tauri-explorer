<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { loadVideoAudio, loadVideoPreview, NoVideoAudio, probeVideoCodec, saveVideoCopy } from "$lib/api/video-preview";
  import { openFile } from "$lib/api/open";
  import { extractError } from "$lib/api/common";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { keybindingsStore } from "$lib/state/keybindings.svelte";
  import {
    audibleVolume, classifyVideoFailure, rememberAudible, setVolumeTo, stepVolume, toggleMuted, unsupportedVideoMessage,
    mediaTime, seekTime, videoClickAction, videoKeyAction, VOLUME_STEP, volumeLevel, volumeText, wheelVolumeDelta, type VolumeState,
  } from "$lib/domain/video-preview";
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
  // Restored when the speaker button unmutes a player left at zero volume (#1425).
  let lastAudible = $state(1);
  const sound = $derived<VolumeState>({ volume, muted });
  const level = $derived(volumeLevel(sound));
  // The slider stays collapsed behind the speaker until hover or keyboard focus reveals it.
  let volumeHovered = $state(false);
  let volumeFocused = $state(false);
  let volumeDismissed = $state(false);
  let muteButton = $state<HTMLButtonElement | null>(null);
  let volumeControl = $state<HTMLDivElement | null>(null);
  const volumeOpen = $derived(ready && !error && (volumeHovered || volumeFocused) && !volumeDismissed);
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
    lastAudible = rememberAudible(lastAudible, { volume, muted });
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
  /**
   * Changes derive from the element itself and render at once: `volumechange`
   * is queued and can trail several inputs, so the slider would otherwise show
   * (and step from) a stale level. External changes still arrive through it.
   */
  function changeSound(change: (current: VolumeState) => VolumeState) {
    if (!video) return;
    const current = { volume: video.volume, muted: video.muted };
    lastAudible = rememberAudible(lastAudible, current);
    const next = change(current);
    video.volume = next.volume;
    video.muted = next.muted;
    sync();
  }
  function setVolume(value: number) { changeSound(current => setVolumeTo(current, value)); }
  function toggleMute() { changeSound(current => toggleMuted(current, lastAudible)); }
  function volumeKey(event: KeyboardEvent) {
    if (event.key !== "Escape" || !volumeOpen) return;
    // Collapse the revealed slider and keep keyboard focus on its speaker button.
    event.preventDefault();
    if (event.target !== muteButton) muteButton?.focus();
    volumeDismissed = true;
  }
  function volumeFocusIn(event: FocusEvent) {
    // Keyboard focus reveals the slider; a pointer click leaves it to hover, so it collapses on leave.
    volumeFocused = (event.target as HTMLElement).matches(":focus-visible");
    volumeDismissed = false;
  }
  function volumeFocusOut(event: FocusEvent) {
    if (!volumeControl?.contains(event.relatedTarget as Node | null)) volumeFocused = false;
  }
  $effect(() => {
    // Non-passive, so wheeling over the speaker adjusts volume instead of scrolling the pane.
    const element = volumeControl;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const delta = wheelVolumeDelta(event.deltaY);
      if (!delta || !ready || error) return;
      event.preventDefault();
      changeSound(current => stepVolume(current, delta));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });
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
      case "volume-up": changeSound(current => stepVolume(current, VOLUME_STEP)); break;
      case "volume-down": changeSound(current => stepVolume(current, -VOLUME_STEP)); break;
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
          {audioNote === "preparing" ? "Preparing audio…" : "Audio unavailable"}</span>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -- hover/focus reveal and Escape collapse for the speaker's slider; the button and range keep native semantics. -->
      <div class="volume" class:open={volumeOpen} data-level={level} bind:this={volumeControl}
        onpointerenter={() => { volumeHovered = true; volumeDismissed = false; }} onpointerleave={() => volumeHovered = false}
        onfocusin={volumeFocusIn} onfocusout={volumeFocusOut} onkeydown={volumeKey}>
        <button type="button" class="volume-button" bind:this={muteButton} aria-label={level === "muted" ? "Unmute video" : "Mute video"}
          aria-pressed={level === "muted"} title={level === "muted" ? "Unmute (M)" : "Mute (M)"} disabled={!ready || !!error} onclick={toggleMute}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
            {#if level === "muted"}
              <path d="M10.6 6.1l3.8 3.8M14.4 6.1l-3.8 3.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            {:else}
              <path d="M10.4 6.1a2.7 2.7 0 0 1 0 3.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              {#if level === "high"}<path d="M12.3 4.2a5.4 5.4 0 0 1 0 7.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>{/if}
            {/if}
          </svg>
        </button>
        <input class="volume-slider" type="range" aria-label="Video volume" aria-valuetext={volumeText(sound)} min="0" max="1" step={VOLUME_STEP}
          value={audibleVolume(sound)} disabled={!ready || !!error}
          oninput={event => setVolume(event.currentTarget.valueAsNumber)} />
      </div>
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
  .volume {display:flex;align-items:center;}
  .volume-button {display:inline-flex;align-items:center;justify-content:center;}
  /* Collapsed: no width and out of the tab order; the speaker alone carries mute. */
  .volume-slider {width:0;margin:0;opacity:0;visibility:hidden;transition:width 120ms ease-out,opacity 120ms ease-out,visibility 0s 120ms;}
  .volume.open .volume-slider {width:64px;margin:0 2px 0 4px;opacity:1;visibility:visible;transition:width 120ms ease-out,opacity 120ms ease-out,visibility 0s;}
  @media (prefers-reduced-motion: reduce) { .volume-slider,.volume.open .volume-slider {transition:none;} }
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
