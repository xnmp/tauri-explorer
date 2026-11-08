<!--
  Large (Tiles) built-in file artwork, 64px on a 48-unit viewBox (#1532).
  Loaded lazily through large-file-art.svelte.ts; FileIcon picks the variant.
  The glyph is drawn twice: an offset copy flattened to translucent black
  beneath it stands in for `filter: drop-shadow(0 2px 2px ...)`, which
  WebKitGTK re-rasterizes for every visible tile on every scroll frame. Do not
  replace the copy with a CSS or SVG <filter>: both re-render per paint.
-->
<script lang="ts">
  import type { LargeFileArtProps } from './large-file-art.svelte';

  let { kind, label, fontSize, color }: LargeFileArtProps = $props();
</script>

<span class="icon-cat icon-{kind}" style:color={kind === "lang" ? color : undefined}>
  <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
    <!-- 1.5 units = 2 CSS px at 64px. -->
    <g class="baked-icon-shadow" transform="translate(0 1.5)">{@render art()}</g>
    {@render art()}
  </svg>
</span>

{#snippet art()}
  {#if kind === "image"}
    <rect x="6" y="6" width="36" height="36" rx="4" fill="currentColor" fill-opacity="0.15"/>
    <rect x="6" y="6" width="36" height="36" rx="4" stroke="currentColor" stroke-width="1.5"/>
    <circle cx="16" cy="16" r="4" fill="currentColor"/>
    <path d="M6 33L15 24L22 31L30 21L42 33V38C42 40.2091 40.2091 42 38 42H10C7.79086 42 6 40.2091 6 38V33Z" fill="currentColor" fill-opacity="0.4"/>
  {:else if kind === "archive"}
    <path d="M10 6C10 4.34315 11.3431 3 13 3H35C36.6569 3 38 4.34315 38 6V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" fill="currentColor" fill-opacity="0.15"/>
    <path d="M10 6C10 4.34315 11.3431 3 13 3H35C36.6569 3 38 4.34315 38 6V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" stroke="currentColor" stroke-width="1.5"/>
    <rect x="18" y="9" width="12" height="6" rx="1" fill="currentColor"/>
    <rect x="18" y="18" width="12" height="6" rx="1" fill="currentColor"/>
    <rect x="18" y="27" width="12" height="9" rx="1" fill="currentColor"/>
  {:else if kind === "lang"}
    <!-- Language fallback: colored rounded rect with extension -->
    <rect x="4" y="4" width="40" height="40" rx="6" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="1.5"/>
    {#if label}
      <text x="24" y="30" text-anchor="middle" font-size="{fontSize + 4}" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor" fill-opacity="0.8">{label}</text>
    {/if}
  {:else if kind === "code"}
    <path d="M10 6C10 4.34315 11.3431 3 13 3H27L38 14V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" fill="currentColor" fill-opacity="0.15"/>
    <path d="M10 6C10 4.34315 11.3431 3 13 3H27L38 14V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" stroke="currentColor" stroke-width="1.5"/>
    <path d="M27 3V11C27 12.6569 28.3431 14 30 14H38" stroke="currentColor" stroke-width="1.5"/>
    {#if label}
      <text x="24" y="33" text-anchor="middle" font-size="{fontSize}" font-weight="700" font-family="system-ui, -apple-system, sans-serif" fill="currentColor" fill-opacity="0.85">{label}</text>
    {:else}
      <path d="M18 24L13 29L18 34M30 24L35 29L30 34" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    {/if}
  {:else if kind === "media"}
    <rect x="6" y="10" width="36" height="28" rx="4" fill="currentColor" fill-opacity="0.15"/>
    <rect x="6" y="10" width="36" height="28" rx="4" stroke="currentColor" stroke-width="1.5"/>
    <path d="M19 18V30L32 24L19 18Z" fill="currentColor"/>
  {:else if kind === "executable"}
    <rect x="6" y="6" width="36" height="36" rx="6" fill="currentColor" fill-opacity="0.15"/>
    <rect x="6" y="6" width="36" height="36" rx="6" stroke="currentColor" stroke-width="1.5"/>
    <path d="M15 24H33M24 15V33" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
  {:else}
    <path d="M11 7C11 5.34 12.34 4 14 4H28L41 17V43C41 44.66 39.66 46 38 46H14C12.34 46 11 44.66 11 43V7Z" fill="black" opacity="0.06"/>
    <path d="M10 6C10 4.34 11.34 3 13 3H27L40 16V42C40 43.66 38.66 45 37 45H13C11.34 45 10 43.66 10 42V6Z" fill="white"/>
    <path d="M10 6C10 4.34 11.34 3 13 3H27L40 16V42C40 43.66 38.66 45 37 45H13C11.34 45 10 43.66 10 42V6Z" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.5"/>
    <path d="M27 3V13C27 14.66 28.34 16 30 16H40" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.5"/>
    <path d="M27 3V12C27 14.21 28.79 16 31 16H40L27 3Z" fill="currentColor" fill-opacity="0.12"/>
    {#if label}
      <text x="24" y="35" text-anchor="middle" font-size="{fontSize}" font-weight="700" font-family="system-ui, -apple-system, sans-serif" fill="currentColor" fill-opacity="0.7">{label}</text>
    {:else}
      <path d="M16 25H32M16 30H28M16 35H24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-opacity="0.6"/>
    {/if}
  {/if}
{/snippet}

<style>
  .icon-cat { display: inline-flex; align-items: center; justify-content: center; }
  .baked-icon-shadow { color: #000; opacity: 0.2; }
  /* The document's paper is white; its shadow is not. */
  .baked-icon-shadow :global([fill="white"]) { fill: currentColor; }
  .icon-image      { color: var(--icon-file-tint, var(--icon-image)); }
  .icon-archive    { color: var(--icon-file-tint, var(--icon-archive)); }
  .icon-code       { color: var(--icon-file-tint, var(--icon-code)); }
  .icon-media      { color: var(--icon-file-tint, var(--icon-media)); }
  .icon-executable { color: var(--icon-file-tint, var(--icon-executable)); }
  .icon-document   { color: var(--icon-file-tint, var(--icon-document)); }
</style>
