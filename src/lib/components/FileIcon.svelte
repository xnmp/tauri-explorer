<!--
  FileIcon component - renders file/folder icons by category and size.
  Shared dispatch for Material, Classic, Minimal and Catppuccin icon packs.
  Issue: tauri-18op, tauri-explorer-gmpb
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { getFileIconCategory, getFileExtensionLabel, isVideoMediaFile, getExtension } from "$lib/domain/file-types";
  import type { IconPack } from '$lib/domain/icon-themes';
  import { iconThemeStore } from '$lib/state/icon-theme.svelte';
  import { fileIconRegistry } from '$lib/plugins/file-icon-registry.svelte';
  import { CLASSIC_LANGUAGE_ICONS, CLASSIC_BRAND_PATHS, type ClassicLanguageIcon } from './icons/classic-artwork';
  import FolderIcon from './FolderIcon.svelte';
  import MaterialFileIcon from './MaterialFileIcon.svelte';
  import CatppuccinFileIcon from './CatppuccinFileIcon.svelte';
  import { largeFileArt, type LargeFileArtKind } from './icons/large-file-art.svelte';

  interface Props {
    entry: FileEntry;
    size: "small" | "large";
    theme?: IconPack;
  }

  let { entry, size, theme }: Props = $props();

  // A plugin's artwork for this extension wins over every icon pack (#1523).
  const pluginIcon = $derived(fileIconRegistry.forEntry(entry));
  const iconCategory = $derived(getFileIconCategory(entry));
  const effectiveTheme = $derived(theme ?? iconThemeStore.effectiveTheme);
  const useMaterial = $derived(effectiveTheme === "material");
  const useMinimal = $derived(effectiveTheme === "minimal");
  const minimalColor = 'var(--icon-file-tint, var(--text-secondary, currentColor))';
  const extLabel = $derived(getFileExtensionLabel(entry));
  /** Font size for extension label - shorter labels get bigger text */
  const extFontSize = $derived(
    extLabel.length <= 2 ? 12 : extLabel.length <= 3 ? 10 : extLabel.length <= 4 ? 8.5 : 7
  );

  const langIcon = $derived<ClassicLanguageIcon | null>(
    entry.kind === "file" && Object.hasOwn(CLASSIC_LANGUAGE_ICONS, getExtension(entry.name))
      ? CLASSIC_LANGUAGE_ICONS[getExtension(entry.name)] : null
  );
  const LargeArt = $derived(size === "large" ? largeFileArt() : undefined);
  const largeKind = $derived<LargeFileArtKind>(
    iconCategory === "image" || iconCategory === "archive" ? iconCategory
      : langIcon ? "lang"
      : iconCategory === "code" || iconCategory === "media" || iconCategory === "executable" ? iconCategory
      : "document"
  );

</script>

{#if pluginIcon}
  <img class="icon-cat plugin-file-icon" src={pluginIcon.src} alt="" draggable="false"
    width={size === "small" ? 16 : 64} height={size === "small" ? 16 : 64} />
{:else if useMaterial && entry.kind === 'file'}
  <MaterialFileIcon {entry} {size} />
{:else if effectiveTheme === 'catppuccin'}
  <CatppuccinFileIcon {entry} {size} />
{:else if isVideoMediaFile(entry)}
  <span class="icon-cat icon-video" role="img" aria-label="Video" style:color={useMinimal ? minimalColor : undefined}>
    <svg width={size === "small" ? 16 : 64} height={size === "small" ? 16 : 64} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g class="baked-icon-shadow" transform="translate(0 0.75)">
        <rect x="2.5" y="3.5" width="19" height="17" rx="2.5" stroke="currentColor" stroke-width="1.5" />
        <path d="M9 7.5L16 12L9 16.5V7.5Z" fill="currentColor" />
      </g>
      <rect x="2.5" y="3.5" width="19" height="17" rx="2.5" stroke="currentColor" stroke-width="1.5" />
      <path d="M9 7.5L16 12L9 16.5V7.5Z" fill="currentColor" />
    </svg>
  </span>
{:else if entry.kind === 'directory'}
  <FolderIcon {entry} {size} theme={effectiveTheme} />
{:else if !useMinimal && langIcon && Object.hasOwn(CLASSIC_BRAND_PATHS, langIcon.id)}
  <span class="icon-cat" style:color={langIcon.color}>
    <svg width={size === 'small' ? 16 : 64} height={size === 'small' ? 16 : 64} viewBox="0 0 128 128" aria-hidden="true">
      <g class="baked-icon-shadow" transform="translate(0 4)">
        <path d={CLASSIC_BRAND_PATHS[langIcon.id]} fill="currentColor"/>
      </g>
      <path d={CLASSIC_BRAND_PATHS[langIcon.id]} fill="currentColor"/>
    </svg>
  </span>
{:else if !useMinimal && (langIcon?.id === 'typescript' || langIcon?.id === 'javascript')}
  <span class="icon-cat language-badge" data-icon-theme="classic">
    <svg width={size === 'small' ? 16 : 64} height={size === 'small' ? 16 : 64} viewBox="0 0 48 48" aria-hidden="true">
      <g class="baked-icon-shadow" transform="translate(0 1.5)">
        <rect x="3" y="3" width="42" height="42" rx="6" fill="currentColor"/>
      </g>
      <rect x="3" y="3" width="42" height="42" rx="6" fill={langIcon.color}/>
      <text x="40" y="38" text-anchor="end" font-family="Arial, sans-serif" font-size="25" font-weight="700" letter-spacing="-1.3" fill={langIcon.id === 'typescript' ? '#fff' : '#252830'}>{langIcon.id === 'typescript' ? 'TS' : 'JS'}</text>
    </svg>
  </span>
{:else if langIcon?.id === "html"}
  <!-- One web-document silhouette across sizes and icon themes. -->
  <span class="icon-cat icon-html" style:color={useMinimal ? minimalColor : langIcon.color}>
    <svg width={size === "small" ? 16 : 64} height={size === "small" ? 16 : 64}
      viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <g class="baked-icon-shadow" transform="translate(0 0.75)">
        <path d="M6 2.5H14L19 7.5V20A1.5 1.5 0 0 1 17.5 21.5H6A1.5 1.5 0 0 1 4.5 20V4A1.5 1.5 0 0 1 6 2.5Z"
          fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M14 2.5V6A1.5 1.5 0 0 0 15.5 7.5H19" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M9 11.5L6.5 14L9 16.5M15 11.5L17.5 14L15 16.5M13 10.5L11 17.5"
          stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      <path d="M6 2.5H14L19 7.5V20A1.5 1.5 0 0 1 17.5 21.5H6A1.5 1.5 0 0 1 4.5 20V4A1.5 1.5 0 0 1 6 2.5Z"
        fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M14 2.5V6A1.5 1.5 0 0 0 15.5 7.5H19" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M9 11.5L6.5 14L9 16.5M15 11.5L17.5 14L15 16.5M13 10.5L11 17.5"
        stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </span>
{:else if useMinimal && size === "small"}
  <!--
    Minimal icon theme: clean monochrome outlines (small)
  -->
    <svg data-icon-theme="minimal" style:color={minimalColor} width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M5 2.5H10.5L14.5 6.5V15C14.5 15.2761 14.2761 15.5 14 15.5H5C4.72386 15.5 4.5 15.2761 4.5 15V3C4.5 2.72386 4.72386 2.5 5 2.5Z" stroke="currentColor" stroke-width="1.25" fill="none"/>
      <path d="M10.5 2.5V6.5H14.5" stroke="currentColor" stroke-width="1.25" fill="none"/>
    </svg>

{:else if useMinimal}
  <!--
    Minimal icon theme: clean monochrome outlines (large)
  -->
    <svg data-icon-theme="minimal" style:color={minimalColor} width="64" height="64" viewBox="0 0 48 48" fill="none">
      <path d="M12 5H28L39 16V43C39 44.1 38.1 45 37 45H12C10.9 45 10 44.1 10 43V7C10 5.9 10.9 5 12 5Z" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M28 5V16H39" stroke="currentColor" stroke-width="1.5" fill="none"/>
      {#if extLabel}
        <text x="24" y="35" text-anchor="middle" font-size="{extFontSize}" font-weight="600" font-family="system-ui, -apple-system, sans-serif" fill="currentColor" fill-opacity="0.6">{extLabel}</text>
      {/if}
    </svg>

{:else if size === "small"}
  <!--
    Small icons: 16x16 element, 18x18 viewBox (list & details views)
  -->
  {#if iconCategory === "image"}
    <span class="icon-cat icon-image">
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="3" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity="0.15"/>
      <rect x="3" y="3" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.25"/>
      <circle cx="6.5" cy="6.5" r="1.5" fill="currentColor"/>
      <path d="M3 12L6 9L8.5 11.5L11 8L15 12V13.5C15 14.3284 14.3284 15 13.5 15H4.5C3.67157 15 3 14.3284 3 13.5V12Z" fill="currentColor" fill-opacity="0.4"/>
    </svg>
    </span>
  {:else if iconCategory === "archive"}
    <span class="icon-cat icon-archive">
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M4 3C4 2.44772 4.44772 2 5 2H13C13.5523 2 14 2.44772 14 3V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" fill="currentColor" fill-opacity="0.15"/>
      <path d="M4 3C4 2.44772 4.44772 2 5 2H13C13.5523 2 14 2.44772 14 3V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke="currentColor" stroke-width="1.25"/>
      <rect x="7" y="4" width="4" height="2" rx="0.5" fill="currentColor"/>
      <rect x="7" y="7" width="4" height="2" rx="0.5" fill="currentColor"/>
      <rect x="7" y="10" width="4" height="3" rx="0.5" fill="currentColor"/>
    </svg>
    </span>
  {:else if langIcon}
    <!-- Language-specific icon using devicon paths -->
    <span class="icon-cat" style:color={langIcon.color}>
      <!-- Fallback: colored rounded square with extension label -->
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.2"/>
        <text x="8" y="12" text-anchor="middle" font-size="7" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor">{extLabel}</text>
      </svg>
    </span>
  {:else if iconCategory === "code"}
    <span class="icon-cat icon-code">
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M4 3C4 2.44772 4.44772 2 5 2H10L14 6V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" fill="currentColor" fill-opacity="0.15"/>
      <path d="M4 3C4 2.44772 4.44772 2 5 2H10L14 6V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke="currentColor" stroke-width="1.25"/>
      <path d="M10 2V5C10 5.55228 10.4477 6 11 6H14" stroke="currentColor" stroke-width="1.25"/>
      <path d="M7.5 9L6 10.5L7.5 12M10.5 9L12 10.5L10.5 12" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    </span>
  {:else if iconCategory === "media"}
    <span class="icon-cat icon-media">
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="4" width="12" height="10" rx="1.5" fill="currentColor" fill-opacity="0.15"/>
      <rect x="3" y="4" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.25"/>
      <path d="M7 7V11L11 9L7 7Z" fill="currentColor"/>
    </svg>
    </span>
  {:else if iconCategory === "executable"}
    <span class="icon-cat icon-executable">
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="3" width="12" height="12" rx="2" fill="currentColor" fill-opacity="0.15"/>
      <rect x="3" y="3" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/>
      <path d="M6 9H12M9 6V12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    </span>
  {:else}
    <span class="icon-cat icon-document">
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M4 3C4 2.44772 4.44772 2 5 2H10L15 7V15C15 15.5523 14.5523 16 14 16H5C4.44772 16 4 15.5523 4 15V3Z" fill="currentColor" fill-opacity="0.15"/>
      <path d="M4 3C4 2.44772 4.44772 2 5 2H10L15 7V15C15 15.5523 14.5523 16 14 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke="currentColor" stroke-width="1.25"/>
      <path d="M10 2V6C10 6.55228 10.4477 7 11 7H15" stroke="currentColor" stroke-width="1.25"/>
      {#if extLabel && extLabel.length <= 4}
        <text x="9.5" y="13.5" text-anchor="middle" font-size="{extLabel.length <= 2 ? 6.5 : 5.5}" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor" fill-opacity="0.7">{extLabel}</text>
      {:else}
        <path d="M6.5 10H11.5M6.5 12.5H10" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
      {/if}
    </svg>
    </span>
  {/if}
{:else if LargeArt}
  <!-- Large (Tiles) artwork lives in a lazy chunk with its static shadow (#1532). -->
  <LargeArt kind={largeKind} label={extLabel} fontSize={extFontSize} color={langIcon?.color} />
{/if}

<style>
  /* Category icon color wrappers — themes override via --icon-file-tint (all) or per-category vars */
  .icon-cat {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  /* No CSS filter on any icon (#1530, #1532): WebKitGTK re-rasterizes a
     filtered element for every visible tile on every scroll frame (Tiles p95
     ~105 ms vs ~24 ms unfiltered on 1,596 tiles). Large built-in artwork
     instead carries a static copy of its shape, offset 2 CSS px and drawn
     black at low opacity beneath the glyph (icons/LargeFileArt.svelte for
     the category artwork); 16px rows draw none. Never swap this for an SVG
     <filter>: it re-renders per paint just the same. */
  .baked-icon-shadow { color: #000; opacity: 0.2; }
  :global(svg[width="16"] > .baked-icon-shadow) { display: none; }
  .icon-cat.plugin-file-icon { object-fit: contain; pointer-events: none; }
  .icon-image      { color: var(--icon-file-tint, var(--icon-image)); }
  .icon-archive    { color: var(--icon-file-tint, var(--icon-archive)); }
  .icon-code       { color: var(--icon-file-tint, var(--icon-code)); }
  .icon-media, .icon-video { color: var(--icon-file-tint, var(--icon-media)); }
  .icon-executable { color: var(--icon-file-tint, var(--icon-executable)); }
  .icon-document   { color: var(--icon-file-tint, var(--icon-document)); }

</style>
