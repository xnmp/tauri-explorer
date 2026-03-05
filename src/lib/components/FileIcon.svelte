<!--
  FileIcon component - renders file/folder icons by category and size.
  Supports two icon themes: "default" (inline SVGs) and "material" (Nerd Font glyphs).
  Issue: tauri-18op, tauri-explorer-gmpb
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { getFileIconCategory } from "$lib/domain/file-types";
  import { getNerdIcon } from "$lib/domain/nerd-icons";
  import { settingsStore } from "$lib/state/settings.svelte";

  interface Props {
    entry: FileEntry;
    size: "small" | "large";
  }

  let { entry, size }: Props = $props();

  const iconCategory = $derived(getFileIconCategory(entry));
  const useMaterial = $derived(settingsStore.iconTheme === "material");
  const nerdIcon = $derived(useMaterial ? getNerdIcon(entry.name, entry.kind) : null);
</script>

{#if useMaterial && nerdIcon}
  <!--
    Material icon theme: Nerd Font glyphs
  -->
  {#if size === "small"}
    <span class="nf-icon nf-small" style:color={nerdIcon.color}>{nerdIcon.glyph}</span>
  {:else if entry.kind === "directory"}
    <span class="nf-icon nf-large nf-folder" style:color={nerdIcon.color}>{nerdIcon.glyph}</span>
  {:else}
    <span class="nf-icon-badge" style:--badge-color={nerdIcon.color}>
      <span class="nf-icon nf-badge-glyph">{nerdIcon.glyph}</span>
    </span>
  {/if}
{:else if size === "small"}
  <!--
    Small icons: 16x16 element, 18x18 viewBox (list & details views)
  -->
  {#if entry.kind === "directory"}
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M2.5 7.5C2.5 6.94772 2.94772 6.5 3.5 6.5H14.5C15.0523 6.5 15.5 6.94772 15.5 7.5V12.5C15.5 13.6046 14.6046 14.5 13.5 14.5H4.5C3.39543 14.5 2.5 13.6046 2.5 12.5V7.5Z" fill="var(--icon-folder, #ffb900)"/>
      <path d="M2 5.5C2 4.67157 2.67157 4 3.5 4H6.17157C6.43679 4 6.69114 4.10536 6.87868 4.29289L8.12132 4.29289C8.30886 4.10536 8.56321 4 8.82843 4H13C13.8284 4 14.5 4.67157 14.5 5.5V6.5H2V5.5Z" fill="var(--icon-folder, #ffb900)" opacity="0.6"/>
    </svg>
  {:else if iconCategory === "image"}
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="3" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity="0.15"/>
      <rect x="3" y="3" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.25"/>
      <circle cx="6.5" cy="6.5" r="1.5" fill="currentColor"/>
      <path d="M3 12L6 9L8.5 11.5L11 8L15 12V13.5C15 14.3284 14.3284 15 13.5 15H4.5C3.67157 15 3 14.3284 3 13.5V12Z" fill="currentColor" fill-opacity="0.4"/>
    </svg>
  {:else if iconCategory === "archive"}
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M4 3C4 2.44772 4.44772 2 5 2H13C13.5523 2 14 2.44772 14 3V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" fill="currentColor" fill-opacity="0.15"/>
      <path d="M4 3C4 2.44772 4.44772 2 5 2H13C13.5523 2 14 2.44772 14 3V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke="currentColor" stroke-width="1.25"/>
      <rect x="7" y="4" width="4" height="2" rx="0.5" fill="currentColor"/>
      <rect x="7" y="7" width="4" height="2" rx="0.5" fill="currentColor"/>
      <rect x="7" y="10" width="4" height="3" rx="0.5" fill="currentColor"/>
    </svg>
  {:else if iconCategory === "code"}
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M4 3C4 2.44772 4.44772 2 5 2H10L14 6V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" fill="currentColor" fill-opacity="0.15"/>
      <path d="M4 3C4 2.44772 4.44772 2 5 2H10L14 6V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke="currentColor" stroke-width="1.25"/>
      <path d="M10 2V5C10 5.55228 10.4477 6 11 6H14" stroke="currentColor" stroke-width="1.25"/>
      <path d="M7.5 9L6 10.5L7.5 12M10.5 9L12 10.5L10.5 12" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  {:else if iconCategory === "media"}
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="4" width="12" height="10" rx="1.5" fill="currentColor" fill-opacity="0.15"/>
      <rect x="3" y="4" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.25"/>
      <path d="M7 7V11L11 9L7 7Z" fill="currentColor"/>
    </svg>
  {:else if iconCategory === "executable"}
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="3" width="12" height="12" rx="2" fill="currentColor" fill-opacity="0.15"/>
      <rect x="3" y="3" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/>
      <path d="M6 9H12M9 6V12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  {:else}
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M4 3C4 2.44772 4.44772 2 5 2H10L15 7V15C15 15.5523 14.5523 16 14 16H5C4.44772 16 4 15.5523 4 15V3Z" fill="currentColor" fill-opacity="0.15"/>
      <path d="M4 3C4 2.44772 4.44772 2 5 2H10L15 7V15C15 15.5523 14.5523 16 14 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke="currentColor" stroke-width="1.25"/>
      <path d="M10 2V6C10 6.55228 10.4477 7 11 7H15" stroke="currentColor" stroke-width="1.25"/>
      <path d="M6.5 10H11.5M6.5 12.5H10" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
    </svg>
  {/if}
{:else}
  <!--
    Large icons: 64x64 element, 48x48 viewBox (tiles view)
  -->
  {#if entry.kind === "directory"}
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="folderBack" x1="24" y1="10" x2="24" y2="41" gradientUnits="userSpaceOnUse">
          <stop stop-color="#ffd660"/>
          <stop offset="1" stop-color="#e8a800"/>
        </linearGradient>
        <linearGradient id="folderFront" x1="24" y1="18" x2="24" y2="42" gradientUnits="userSpaceOnUse">
          <stop stop-color="#ffe08a"/>
          <stop offset="1" stop-color="#f0b400"/>
        </linearGradient>
      </defs>
      <path d="M4 14C4 11.79 5.79 10 8 10H16.34C17.4 10 18.42 10.42 19.17 11.17L22 14H40C42.21 14 44 15.79 44 18V37C44 39.21 42.21 41 40 41H8C5.79 41 4 39.21 4 37V14Z" fill="url(#folderBack)"/>
      <rect x="4" y="18" width="40" height="2" fill="#d4960a" opacity="0.3" rx="0.5"/>
      <path d="M2 22C2 20.34 3.34 19 5 19H43C44.66 19 46 20.34 46 22V39C46 40.66 44.66 42 43 42H5C3.34 42 2 40.66 2 39V22Z" fill="url(#folderFront)"/>
      <path d="M2 22C2 20.34 3.34 19 5 19H43C44.66 19 46 20.34 46 22V23H2V22Z" fill="white" opacity="0.25"/>
    </svg>
  {:else if iconCategory === "image"}
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <rect x="6" y="6" width="36" height="36" rx="4" fill="currentColor" fill-opacity="0.15"/>
      <rect x="6" y="6" width="36" height="36" rx="4" stroke="currentColor" stroke-width="1.5"/>
      <circle cx="16" cy="16" r="4" fill="currentColor"/>
      <path d="M6 33L15 24L22 31L30 21L42 33V38C42 40.2091 40.2091 42 38 42H10C7.79086 42 6 40.2091 6 38V33Z" fill="currentColor" fill-opacity="0.4"/>
    </svg>
  {:else if iconCategory === "archive"}
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <path d="M10 6C10 4.34315 11.3431 3 13 3H35C36.6569 3 38 4.34315 38 6V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" fill="currentColor" fill-opacity="0.15"/>
      <path d="M10 6C10 4.34315 11.3431 3 13 3H35C36.6569 3 38 4.34315 38 6V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" stroke="currentColor" stroke-width="1.5"/>
      <rect x="18" y="9" width="12" height="6" rx="1" fill="currentColor"/>
      <rect x="18" y="18" width="12" height="6" rx="1" fill="currentColor"/>
      <rect x="18" y="27" width="12" height="9" rx="1" fill="currentColor"/>
    </svg>
  {:else if iconCategory === "code"}
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <path d="M10 6C10 4.34315 11.3431 3 13 3H27L38 14V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" fill="currentColor" fill-opacity="0.15"/>
      <path d="M10 6C10 4.34315 11.3431 3 13 3H27L38 14V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" stroke="currentColor" stroke-width="1.5"/>
      <path d="M27 3V11C27 12.6569 28.3431 14 30 14H38" stroke="currentColor" stroke-width="1.5"/>
      <path d="M18 24L13 29L18 34M30 24L35 29L30 34" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  {:else if iconCategory === "media"}
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <rect x="6" y="10" width="36" height="28" rx="4" fill="currentColor" fill-opacity="0.15"/>
      <rect x="6" y="10" width="36" height="28" rx="4" stroke="currentColor" stroke-width="1.5"/>
      <path d="M19 18V30L32 24L19 18Z" fill="currentColor"/>
    </svg>
  {:else if iconCategory === "executable"}
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <rect x="6" y="6" width="36" height="36" rx="6" fill="currentColor" fill-opacity="0.15"/>
      <rect x="6" y="6" width="36" height="36" rx="6" stroke="currentColor" stroke-width="1.5"/>
      <path d="M15 24H33M24 15V33" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
    </svg>
  {:else}
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <path d="M11 7C11 5.34 12.34 4 14 4H28L41 17V43C41 44.66 39.66 46 38 46H14C12.34 46 11 44.66 11 43V7Z" fill="black" opacity="0.06"/>
      <path d="M10 6C10 4.34 11.34 3 13 3H27L40 16V42C40 43.66 38.66 45 37 45H13C11.34 45 10 43.66 10 42V6Z" fill="white"/>
      <path d="M10 6C10 4.34 11.34 3 13 3H27L40 16V42C40 43.66 38.66 45 37 45H13C11.34 45 10 43.66 10 42V6Z" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.5"/>
      <path d="M27 3V13C27 14.66 28.34 16 30 16H40" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.5"/>
      <path d="M27 3V12C27 14.21 28.79 16 31 16H40L27 3Z" fill="currentColor" fill-opacity="0.12"/>
      <path d="M16 25H32M16 30H28M16 35H24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-opacity="0.6"/>
    </svg>
  {/if}
{/if}

<style>
  /* Small material icons (list/details view) */
  .nf-small {
    font-size: 16px;
    line-height: 16px;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* Large folder icon (tiles view) — bare glyph, large and warm */
  .nf-folder {
    font-size: 56px;
    line-height: 64px;
    width: 64px;
    height: 64px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.15));
  }

  /* Large file icon badge (tiles view) — prominent glyph with subtle backing */
  .nf-icon-badge {
    width: 64px;
    height: 64px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  .nf-icon-badge::before {
    content: "";
    position: absolute;
    inset: 6px;
    border-radius: 8px;
    background: var(--badge-color);
    opacity: 0.1;
  }

  .nf-badge-glyph {
    position: relative;
    z-index: 1;
    font-size: 42px;
    color: var(--badge-color);
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2));
  }
</style>
