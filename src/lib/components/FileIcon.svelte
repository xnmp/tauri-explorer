<!--
  FileIcon component - renders file/folder icons by category and size.
  Supports two icon themes: "default" (inline SVGs) and "material" (Nerd Font glyphs).
  Issue: tauri-18op, tauri-explorer-gmpb
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { getFileIconCategory, getFileExtensionLabel } from "$lib/domain/file-types";
  import { getNerdIcon } from "$lib/domain/nerd-icons";
  import { settingsStore } from "$lib/state/settings.svelte";

  interface Props {
    entry: FileEntry;
    size: "small" | "large";
  }

  let { entry, size }: Props = $props();

  const iconCategory = $derived(getFileIconCategory(entry));
  const effectiveTheme = $derived(settingsStore.effectiveIconTheme);
  const useMaterial = $derived(effectiveTheme === "material");
  const useMinimal = $derived(effectiveTheme === "minimal");
  const nerdIcon = $derived(useMaterial ? getNerdIcon(entry.name, entry.kind) : null);
  const extLabel = $derived(getFileExtensionLabel(entry));
  /** Font size for extension label - shorter labels get bigger text */
  const extFontSize = $derived(
    extLabel.length <= 2 ? 12 : extLabel.length <= 3 ? 10 : extLabel.length <= 4 ? 8.5 : 7
  );

  /** Language-specific icon for known file extensions (default theme only) */
  interface LangIcon { id: string; color: string; }
  const LANG_ICONS: Record<string, LangIcon> = {
    py: { id: "python", color: "#3776ab" },
    rs: { id: "rust", color: "#dea584" },
    go: { id: "go", color: "#00add8" },
    ts: { id: "typescript", color: "#3178c6" },
    tsx: { id: "typescript", color: "#3178c6" },
    js: { id: "javascript", color: "#f7df1e" },
    jsx: { id: "javascript", color: "#f7df1e" },
    java: { id: "java", color: "#ed8b00" },
    rb: { id: "ruby", color: "#cc342d" },
    cpp: { id: "cpp", color: "#659ad2" },
    c: { id: "c", color: "#a8b9cc" },
    cs: { id: "csharp", color: "#68217a" },
    swift: { id: "swift", color: "#f05138" },
    kt: { id: "kotlin", color: "#7f52ff" },
    php: { id: "php", color: "#777bb4" },
    html: { id: "html", color: "#e44d26" },
    css: { id: "css", color: "#264de4" },
    json: { id: "json", color: "#f5a623" },
    md: { id: "markdown", color: "#083fa1" },
    sh: { id: "shell", color: "#4eaa25" },
    bash: { id: "shell", color: "#4eaa25" },
  };

  function getExt(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.substring(dot + 1).toLowerCase() : "";
  }

  const langIcon = $derived<LangIcon | null>(
    entry.kind === "file" ? (LANG_ICONS[getExt(entry.name)] ?? null) : null
  );
</script>

{#if useMaterial && nerdIcon && entry.kind !== "directory"}
  <!--
    Material icon theme: Nerd Font glyphs (folders use the default SVG icons)
  -->
  {#if size === "small"}
    <span class="nf-icon nf-small" style:color={nerdIcon.color}>{nerdIcon.glyph}</span>
  {:else}
    <span class="nf-icon-badge" style:--badge-color={nerdIcon.color}>
      <span class="nf-icon nf-badge-glyph">{nerdIcon.glyph}</span>
    </span>
  {/if}
{:else if useMinimal && size === "small"}
  <!--
    Minimal icon theme: clean monochrome outlines (small)
  -->
  {#if entry.kind === "directory"}
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M3 6.5H15V13C15 13.8284 14.3284 14.5 13.5 14.5H4.5C3.67157 14.5 3 13.8284 3 13V6.5Z" stroke="currentColor" stroke-width="1.25" fill="none"/>
      <path d="M3 5.5C3 4.67 3.67 4 4.5 4H7L9 6H13.5C14.33 6 15 6.67 15 7.5" stroke="currentColor" stroke-width="1.25" fill="none"/>
    </svg>
  {:else}
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M5 2.5H10.5L14.5 6.5V15C14.5 15.2761 14.2761 15.5 14 15.5H5C4.72386 15.5 4.5 15.2761 4.5 15V3C4.5 2.72386 4.72386 2.5 5 2.5Z" stroke="currentColor" stroke-width="1.25" fill="none"/>
      <path d="M10.5 2.5V6.5H14.5" stroke="currentColor" stroke-width="1.25" fill="none"/>
    </svg>
  {/if}
{:else if useMinimal}
  <!--
    Minimal icon theme: clean monochrome outlines (large)
  -->
  {#if entry.kind === "directory"}
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <path d="M5 18H43V38C43 39.66 41.66 41 40 41H8C6.34 41 5 39.66 5 38V18Z" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M5 14C5 12.34 6.34 11 8 11H17L21 15H40C41.66 15 43 16.34 43 18" stroke="currentColor" stroke-width="1.5" fill="none"/>
    </svg>
  {:else}
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <path d="M12 5H28L39 16V43C39 44.1 38.1 45 37 45H12C10.9 45 10 44.1 10 43V7C10 5.9 10.9 5 12 5Z" stroke="currentColor" stroke-width="1.5" fill="none"/>
      <path d="M28 5V16H39" stroke="currentColor" stroke-width="1.5" fill="none"/>
      {#if extLabel}
        <text x="24" y="35" text-anchor="middle" font-size="{extFontSize}" font-weight="600" font-family="system-ui, -apple-system, sans-serif" fill="currentColor" fill-opacity="0.6">{extLabel}</text>
      {/if}
    </svg>
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
    {#if langIcon.id === "python"}
      <svg width="16" height="16" viewBox="0 0 128 128"><path d="M49.33 62h29.159C86.606 62 93 55.132 93 46.981V19.183c0-7.912-6.632-13.856-14.555-15.176-5.014-.835-10.195-1.215-15.187-1.191-4.99.023-9.612.448-13.805 1.191C37.098 6.188 35 10.758 35 19.183V30h29v4H23.776c-8.484 0-15.914 5.108-18.237 14.811-2.681 11.12-2.8 17.919 0 29.53C7.614 86.983 12.569 93 21.054 93H31V79.952C31 70.315 39.428 62 49.33 62zm-1.838-39.11c-3.026 0-5.478-2.479-5.478-5.545 0-3.079 2.451-5.581 5.478-5.581 3.015 0 5.479 2.502 5.479 5.581-.001 3.066-2.465 5.545-5.479 5.545zm74.789 25.921C120.183 40.363 116.178 34 107.682 34H97v12.981C97 57.031 88.206 65 78.489 65H49.33C41.342 65 35 72.326 35 80.326v27.8c0 7.91 6.745 12.564 14.462 14.834 9.242 2.717 17.994 3.208 29.051 0C85.862 120.831 93 116.549 93 108.126V97H64v-4h43.682c8.484 0 11.647-5.776 14.599-14.66 3.047-9.145 2.916-17.799 0-29.529zm-41.955 55.606c3.027 0 5.479 2.479 5.479 5.547 0 3.076-2.451 5.579-5.479 5.579-3.015 0-5.478-2.502-5.478-5.579 0-3.068 2.463-5.547 5.478-5.547z" fill="currentColor"/></svg>
    {:else if langIcon.id === "typescript"}
      <svg width="16" height="16" viewBox="0 0 128 128"><path d="M2 63.91v62.5h125v-125H2zm100.73-5a15.56 15.56 0 017.82 4.5 20.58 20.58 0 013 4c0 .16-5.4 3.81-8.69 5.85-.12.08-.6-.44-1.13-1.23a7.09 7.09 0 00-5.87-3.53c-3.79-.26-6.23 1.73-6.21 5a4.58 4.58 0 00.54 2.34c.83 1.73 2.38 2.76 7.24 4.86 8.95 3.85 12.78 6.39 15.16 10 2.66 4 3.25 10.46 1.45 15.24-2 5.2-6.9 8.73-13.83 9.9a38.32 38.32 0 01-9.52-.1A23 23 0 0180 109.19c-1.15-1.27-3.39-4.58-3.25-4.82a9.34 9.34 0 011.15-.73l4.6-2.64 3.59-2.08.75 1.11a16.78 16.78 0 004.74 4.54c4 2.1 9.46 1.81 12.16-.62a5.43 5.43 0 00.69-6.92c-1-1.39-3-2.56-8.59-5-6.45-2.78-9.23-4.5-11.77-7.24a16.48 16.48 0 01-3.43-6.25 25 25 0 01-.22-8c1.33-6.23 6-10.58 12.82-11.87a31.66 31.66 0 019.49.26zm-29.34 5.24v5.12H57.16v46.23H45.65V69.26H29.38v-5a49.19 49.19 0 01.14-5.16c.06-.08 10-.12 22-.1h21.81z" fill="currentColor"/></svg>
    {:else if langIcon.id === "javascript"}
      <svg width="16" height="16" viewBox="0 0 128 128"><path d="M2 1v125h125V1H2zm66.119 106.513c-1.845 3.749-5.367 6.212-9.448 7.401-6.271 1.44-12.269.619-16.731-2.059-2.986-1.832-5.318-4.652-6.901-7.901l9.52-5.83c.083.035.333.487.667 1.071 1.214 2.034 2.261 3.474 4.319 4.485 2.022.69 6.461 1.131 8.175-2.427 1.047-1.81.714-7.628.714-14.065C58.433 78.073 58.48 68 58.48 58h11.709c0 11 .06 21.418 0 32.152.025 6.58.596 12.446-2.07 17.361zm48.574-3.308c-4.07 13.922-26.762 14.374-35.83 5.176-1.916-2.165-3.117-3.296-4.26-5.795 4.819-2.772 4.819-2.772 9.508-5.485 2.547 3.915 4.902 6.068 9.139 6.949 5.748.702 11.531-1.273 10.234-7.378-1.333-4.986-11.77-6.199-18.873-11.531-7.211-4.843-8.901-16.611-2.975-23.335 1.975-2.487 5.343-4.343 8.877-5.235l3.688-.477c7.081-.143 11.507 1.727 14.756 5.355.904.916 1.642 1.904 3.022 4.045-3.772 2.404-3.76 2.381-9.163 5.879-1.154-2.486-3.069-4.046-5.093-4.724-3.142-.952-7.104.083-7.926 3.403-.285 1.023-.226 1.975.227 3.665 1.273 2.903 5.545 4.165 9.377 5.926 11.031 4.474 14.756 9.271 15.672 14.981.882 4.916-.213 8.105-.38 8.581z" fill="currentColor"/></svg>
    {:else if langIcon.id === "html"}
      <svg width="16" height="16" viewBox="0 0 128 128"><path d="M9.032 2l10.005 112.093 44.896 12.401 45.02-12.387L118.968 2H9.032zm89.126 26.539l-.627 7.172L97.255 39H44.59l1.257 14h50.156l-.336 3.471-3.233 36.119-.238 2.27L64 102.609v.002l-.034.018-28.177-7.423L33.876 74h13.815l.979 10.919L63.957 89H64v-.546l15.355-3.875L80.959 67H33.261l-3.383-38.117L29.549 25h68.939l-.33 3.539z" fill="currentColor"/></svg>
    {:else if langIcon.id === "css"}
      <svg width="16" height="16" viewBox="0 0 128 128"><path d="M8.76 1l10.055 112.883 45.118 12.58 45.244-12.626L119.24 1H8.76zm89.591 25.862l-3.347 37.605.01.203-.014.467v-.004l-2.378 26.294-.262 2.336L64 101.607v.001l-.022.019-28.311-7.888L33.75 72h13.883l.985 11.054 15.386 4.17-.004.008v-.002l15.443-4.229L81.075 65H48.792l-.277-3.043-.631-7.129L47.553 51h34.749l1.264-14H30.64l-.277-3.041-.63-7.131L29.401 23h69.281l-.331 3.862z" fill="currentColor"/></svg>
    {:else}
      <!-- Fallback: colored rounded square with extension label -->
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.2"/>
        <text x="8" y="12" text-anchor="middle" font-size="7" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor">{extLabel}</text>
      </svg>
    {/if}
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
{:else}
  <!--
    Large icons: 64x64 element, 48x48 viewBox (tiles view)
  -->
  {#if entry.kind === "directory"}
    <svg class="folder-large" width="64" height="64" viewBox="0 0 48 48" fill="none">
      <path d="M4 14C4 11.79 5.79 10 8 10H16.34C17.4 10 18.42 10.42 19.17 11.17L22 14H40C42.21 14 44 15.79 44 18V37C44 39.21 42.21 41 40 41H8C5.79 41 4 39.21 4 37V14Z" fill="var(--icon-folder, #e8a800)" opacity="0.85"/>
      <rect x="4" y="18" width="40" height="2" fill="var(--icon-folder, #e8a800)" opacity="0.2" rx="0.5"/>
      <path d="M2 22C2 20.34 3.34 19 5 19H43C44.66 19 46 20.34 46 22V39C46 40.66 44.66 42 43 42H5C3.34 42 2 40.66 2 39V22Z" fill="var(--icon-folder, #f0b400)"/>
      <path d="M2 22C2 20.34 3.34 19 5 19H43C44.66 19 46 20.34 46 22V23H2V22Z" fill="white" opacity="0.25"/>
    </svg>
  {:else if iconCategory === "image"}
    <span class="icon-cat icon-image">
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <rect x="6" y="6" width="36" height="36" rx="4" fill="currentColor" fill-opacity="0.15"/>
      <rect x="6" y="6" width="36" height="36" rx="4" stroke="currentColor" stroke-width="1.5"/>
      <circle cx="16" cy="16" r="4" fill="currentColor"/>
      <path d="M6 33L15 24L22 31L30 21L42 33V38C42 40.2091 40.2091 42 38 42H10C7.79086 42 6 40.2091 6 38V33Z" fill="currentColor" fill-opacity="0.4"/>
    </svg>
    </span>
  {:else if iconCategory === "archive"}
    <span class="icon-cat icon-archive">
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <path d="M10 6C10 4.34315 11.3431 3 13 3H35C36.6569 3 38 4.34315 38 6V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" fill="currentColor" fill-opacity="0.15"/>
      <path d="M10 6C10 4.34315 11.3431 3 13 3H35C36.6569 3 38 4.34315 38 6V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" stroke="currentColor" stroke-width="1.5"/>
      <rect x="18" y="9" width="12" height="6" rx="1" fill="currentColor"/>
      <rect x="18" y="18" width="12" height="6" rx="1" fill="currentColor"/>
      <rect x="18" y="27" width="12" height="9" rx="1" fill="currentColor"/>
    </svg>
    </span>
  {:else if langIcon}
    <!-- Large language-specific icon (tiles view) -->
    <span class="icon-cat" style:color={langIcon.color}>
    {#if langIcon.id === "python"}
      <svg width="64" height="64" viewBox="0 0 128 128"><path d="M49.33 62h29.159C86.606 62 93 55.132 93 46.981V19.183c0-7.912-6.632-13.856-14.555-15.176-5.014-.835-10.195-1.215-15.187-1.191-4.99.023-9.612.448-13.805 1.191C37.098 6.188 35 10.758 35 19.183V30h29v4H23.776c-8.484 0-15.914 5.108-18.237 14.811-2.681 11.12-2.8 17.919 0 29.53C7.614 86.983 12.569 93 21.054 93H31V79.952C31 70.315 39.428 62 49.33 62zm-1.838-39.11c-3.026 0-5.478-2.479-5.478-5.545 0-3.079 2.451-5.581 5.478-5.581 3.015 0 5.479 2.502 5.479 5.581-.001 3.066-2.465 5.545-5.479 5.545zm74.789 25.921C120.183 40.363 116.178 34 107.682 34H97v12.981C97 57.031 88.206 65 78.489 65H49.33C41.342 65 35 72.326 35 80.326v27.8c0 7.91 6.745 12.564 14.462 14.834 9.242 2.717 17.994 3.208 29.051 0C85.862 120.831 93 116.549 93 108.126V97H64v-4h43.682c8.484 0 11.647-5.776 14.599-14.66 3.047-9.145 2.916-17.799 0-29.529zm-41.955 55.606c3.027 0 5.479 2.479 5.479 5.547 0 3.076-2.451 5.579-5.479 5.579-3.015 0-5.478-2.502-5.478-5.579 0-3.068 2.463-5.547 5.478-5.547z" fill="currentColor"/></svg>
    {:else if langIcon.id === "typescript"}
      <svg width="64" height="64" viewBox="0 0 128 128"><path d="M2 63.91v62.5h125v-125H2zm100.73-5a15.56 15.56 0 017.82 4.5 20.58 20.58 0 013 4c0 .16-5.4 3.81-8.69 5.85-.12.08-.6-.44-1.13-1.23a7.09 7.09 0 00-5.87-3.53c-3.79-.26-6.23 1.73-6.21 5a4.58 4.58 0 00.54 2.34c.83 1.73 2.38 2.76 7.24 4.86 8.95 3.85 12.78 6.39 15.16 10 2.66 4 3.25 10.46 1.45 15.24-2 5.2-6.9 8.73-13.83 9.9a38.32 38.32 0 01-9.52-.1A23 23 0 0180 109.19c-1.15-1.27-3.39-4.58-3.25-4.82a9.34 9.34 0 011.15-.73l4.6-2.64 3.59-2.08.75 1.11a16.78 16.78 0 004.74 4.54c4 2.1 9.46 1.81 12.16-.62a5.43 5.43 0 00.69-6.92c-1-1.39-3-2.56-8.59-5-6.45-2.78-9.23-4.5-11.77-7.24a16.48 16.48 0 01-3.43-6.25 25 25 0 01-.22-8c1.33-6.23 6-10.58 12.82-11.87a31.66 31.66 0 019.49.26zm-29.34 5.24v5.12H57.16v46.23H45.65V69.26H29.38v-5a49.19 49.19 0 01.14-5.16c.06-.08 10-.12 22-.1h21.81z" fill="currentColor"/></svg>
    {:else if langIcon.id === "javascript"}
      <svg width="64" height="64" viewBox="0 0 128 128"><path d="M2 1v125h125V1H2zm66.119 106.513c-1.845 3.749-5.367 6.212-9.448 7.401-6.271 1.44-12.269.619-16.731-2.059-2.986-1.832-5.318-4.652-6.901-7.901l9.52-5.83c.083.035.333.487.667 1.071 1.214 2.034 2.261 3.474 4.319 4.485 2.022.69 6.461 1.131 8.175-2.427 1.047-1.81.714-7.628.714-14.065C58.433 78.073 58.48 68 58.48 58h11.709c0 11 .06 21.418 0 32.152.025 6.58.596 12.446-2.07 17.361zm48.574-3.308c-4.07 13.922-26.762 14.374-35.83 5.176-1.916-2.165-3.117-3.296-4.26-5.795 4.819-2.772 4.819-2.772 9.508-5.485 2.547 3.915 4.902 6.068 9.139 6.949 5.748.702 11.531-1.273 10.234-7.378-1.333-4.986-11.77-6.199-18.873-11.531-7.211-4.843-8.901-16.611-2.975-23.335 1.975-2.487 5.343-4.343 8.877-5.235l3.688-.477c7.081-.143 11.507 1.727 14.756 5.355.904.916 1.642 1.904 3.022 4.045-3.772 2.404-3.76 2.381-9.163 5.879-1.154-2.486-3.069-4.046-5.093-4.724-3.142-.952-7.104.083-7.926 3.403-.285 1.023-.226 1.975.227 3.665 1.273 2.903 5.545 4.165 9.377 5.926 11.031 4.474 14.756 9.271 15.672 14.981.882 4.916-.213 8.105-.38 8.581z" fill="currentColor"/></svg>
    {:else if langIcon.id === "html"}
      <svg width="64" height="64" viewBox="0 0 128 128"><path d="M9.032 2l10.005 112.093 44.896 12.401 45.02-12.387L118.968 2H9.032zm89.126 26.539l-.627 7.172L97.255 39H44.59l1.257 14h50.156l-.336 3.471-3.233 36.119-.238 2.27L64 102.609v.002l-.034.018-28.177-7.423L33.876 74h13.815l.979 10.919L63.957 89H64v-.546l15.355-3.875L80.959 67H33.261l-3.383-38.117L29.549 25h68.939l-.33 3.539z" fill="currentColor"/></svg>
    {:else if langIcon.id === "css"}
      <svg width="64" height="64" viewBox="0 0 128 128"><path d="M8.76 1l10.055 112.883 45.118 12.58 45.244-12.626L119.24 1H8.76zm89.591 25.862l-3.347 37.605.01.203-.014.467v-.004l-2.378 26.294-.262 2.336L64 101.607v.001l-.022.019-28.311-7.888L33.75 72h13.883l.985 11.054 15.386 4.17-.004.008v-.002l15.443-4.229L81.075 65H48.792l-.277-3.043-.631-7.129L47.553 51h34.749l1.264-14H30.64l-.277-3.041-.63-7.131L29.401 23h69.281l-.331 3.862z" fill="currentColor"/></svg>
    {:else}
      <!-- Fallback: colored rounded rect with extension -->
      <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
        <rect x="4" y="4" width="40" height="40" rx="6" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="1.5"/>
        {#if extLabel}
          <text x="24" y="30" text-anchor="middle" font-size="{extFontSize + 4}" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor" fill-opacity="0.8">{extLabel}</text>
        {/if}
      </svg>
    {/if}
    </span>
  {:else if iconCategory === "code"}
    <span class="icon-cat icon-code">
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <path d="M10 6C10 4.34315 11.3431 3 13 3H27L38 14V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" fill="currentColor" fill-opacity="0.15"/>
      <path d="M10 6C10 4.34315 11.3431 3 13 3H27L38 14V42C38 43.6569 36.6569 45 35 45H13C11.3431 45 10 43.6569 10 42V6Z" stroke="currentColor" stroke-width="1.5"/>
      <path d="M27 3V11C27 12.6569 28.3431 14 30 14H38" stroke="currentColor" stroke-width="1.5"/>
      {#if extLabel}
        <text x="24" y="33" text-anchor="middle" font-size="{extFontSize}" font-weight="700" font-family="system-ui, -apple-system, sans-serif" fill="currentColor" fill-opacity="0.85">{extLabel}</text>
      {:else}
        <path d="M18 24L13 29L18 34M30 24L35 29L30 34" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      {/if}
    </svg>
    </span>
  {:else if iconCategory === "media"}
    <span class="icon-cat icon-media">
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <rect x="6" y="10" width="36" height="28" rx="4" fill="currentColor" fill-opacity="0.15"/>
      <rect x="6" y="10" width="36" height="28" rx="4" stroke="currentColor" stroke-width="1.5"/>
      <path d="M19 18V30L32 24L19 18Z" fill="currentColor"/>
    </svg>
    </span>
  {:else if iconCategory === "executable"}
    <span class="icon-cat icon-executable">
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <rect x="6" y="6" width="36" height="36" rx="6" fill="currentColor" fill-opacity="0.15"/>
      <rect x="6" y="6" width="36" height="36" rx="6" stroke="currentColor" stroke-width="1.5"/>
      <path d="M15 24H33M24 15V33" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
    </svg>
    </span>
  {:else}
    <span class="icon-cat icon-document">
    <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
      <path d="M11 7C11 5.34 12.34 4 14 4H28L41 17V43C41 44.66 39.66 46 38 46H14C12.34 46 11 44.66 11 43V7Z" fill="black" opacity="0.06"/>
      <path d="M10 6C10 4.34 11.34 3 13 3H27L40 16V42C40 43.66 38.66 45 37 45H13C11.34 45 10 43.66 10 42V6Z" fill="white"/>
      <path d="M10 6C10 4.34 11.34 3 13 3H27L40 16V42C40 43.66 38.66 45 37 45H13C11.34 45 10 43.66 10 42V6Z" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.5"/>
      <path d="M27 3V13C27 14.66 28.34 16 30 16H40" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.5"/>
      <path d="M27 3V12C27 14.21 28.79 16 31 16H40L27 3Z" fill="currentColor" fill-opacity="0.12"/>
      {#if extLabel}
        <text x="24" y="35" text-anchor="middle" font-size="{extFontSize}" font-weight="700" font-family="system-ui, -apple-system, sans-serif" fill="currentColor" fill-opacity="0.7">{extLabel}</text>
      {:else}
        <path d="M16 25H32M16 30H28M16 35H24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-opacity="0.6"/>
      {/if}
    </svg>
    </span>
  {/if}
{/if}

<style>
  /* Category icon color wrappers — themes override via --icon-file-tint (all) or per-category vars */
  .icon-cat {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.25));
  }
  .icon-image      { color: var(--icon-file-tint, var(--icon-image)); }
  .icon-archive    { color: var(--icon-file-tint, var(--icon-archive)); }
  .icon-code       { color: var(--icon-file-tint, var(--icon-code)); }
  .icon-media      { color: var(--icon-file-tint, var(--icon-media)); }
  .icon-executable { color: var(--icon-file-tint, var(--icon-executable)); }
  .icon-document   { color: var(--icon-file-tint, var(--icon-document)); }

  .folder-large {
    filter: drop-shadow(0 2px 2px rgba(0, 0, 0, 0.25));
  }

  .nf-small {
    font-size: 16px;
    line-height: 16px;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* Large file icon badge (tiles view) — prominent glyph with subtle backing */
  .nf-icon-badge {
    width: 64px;
    height: 64px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    position: relative;
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.25));
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
