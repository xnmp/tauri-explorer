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
    <!-- Language-specific icon -->
    <span class="icon-cat" style:color={langIcon.color}>
    {#if langIcon.id === "python"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M7.9 1C5.4 1 5.5 2.1 5.5 2.1V3.5H8V4H3.6S1 3.7 1 8s2.3 4 2.3 4H4.6V11.3S4.5 9 6.9 9H9.1C10.2 9 11 8.2 11 7.1V3.4C11 2.3 9.9 1 7.9 1ZM5.8 2.3a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z" fill="currentColor"/>
        <path d="M8.1 15c2.5 0 2.4-1.1 2.4-1.1V12.5H8v-.5h4.4s2.6.3 2.6-3.9-2.3-4-2.3-4H11.4V4.7S11.5 7 9.1 7H6.9C5.8 7 5 7.8 5 8.9v3.7C5 13.7 6.1 15 8.1 15Zm2.1-1.3a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4Z" fill="currentColor"/>
      </svg>
    {:else if langIcon.id === "rust"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2"/>
        <path d="M5 10V6.5C5 5.67 5.67 5 6.5 5H9.5C10.33 5 11 5.67 11 6.5V10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        <path d="M5 8H11" stroke="currentColor" stroke-width="1.2"/>
        <circle cx="8" cy="2.5" r="0.8" fill="currentColor"/>
      </svg>
    {:else if langIcon.id === "go"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 7.5C2 7.5 3.5 5 8 5S14 7.5 14 7.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        <circle cx="5.5" cy="7.5" r="2.5" stroke="currentColor" stroke-width="1.2"/>
        <circle cx="10.5" cy="7.5" r="2.5" stroke="currentColor" stroke-width="1.2"/>
        <circle cx="5.5" cy="7.2" r="0.8" fill="currentColor"/>
        <circle cx="10.5" cy="7.2" r="0.8" fill="currentColor"/>
      </svg>
    {:else if langIcon.id === "typescript"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.2"/>
        <text x="8" y="12" text-anchor="middle" font-size="8" font-weight="800" font-family="system-ui, sans-serif" fill="currentColor">TS</text>
      </svg>
    {:else if langIcon.id === "javascript"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.2"/>
        <text x="8" y="12" text-anchor="middle" font-size="8" font-weight="800" font-family="system-ui, sans-serif" fill="currentColor">JS</text>
      </svg>
    {:else if langIcon.id === "java"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.2"/>
        <text x="8" y="12" text-anchor="middle" font-size="7" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor">J</text>
      </svg>
    {:else if langIcon.id === "ruby"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <polygon points="8,2 13,5 13,11 8,14 3,11 3,5" stroke="currentColor" stroke-width="1.2" fill="currentColor" fill-opacity="0.15"/>
        <text x="8" y="10.5" text-anchor="middle" font-size="6" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor">rb</text>
      </svg>
    {:else if langIcon.id === "cpp" || langIcon.id === "c" || langIcon.id === "csharp"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.2"/>
        <text x="8" y="12" text-anchor="middle" font-size="8" font-weight="800" font-family="system-ui, sans-serif" fill="currentColor">{langIcon.id === "cpp" ? "C+" : langIcon.id === "csharp" ? "C#" : "C"}</text>
      </svg>
    {:else if langIcon.id === "html"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 2L4 13L8 14.5L12 13L13 2H3Z" stroke="currentColor" stroke-width="1.1" fill="currentColor" fill-opacity="0.12"/>
        <path d="M5.5 5H10.5L10 8H6.5L6.8 10L8 10.5L9.2 10" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    {:else if langIcon.id === "css"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 2L4 13L8 14.5L12 13L13 2H3Z" stroke="currentColor" stroke-width="1.1" fill="currentColor" fill-opacity="0.12"/>
        <path d="M10.5 5H5.5L5.8 7H10L9.5 10L8 10.5L6.5 10" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    {:else if langIcon.id === "json"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.2"/>
        <text x="8" y="11.5" text-anchor="middle" font-size="6" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor">{"{ }"}</text>
      </svg>
    {:else if langIcon.id === "markdown"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="1.1"/>
        <path d="M4 10V6L6 8.5L8 6V10" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M11 10V7L12.5 8.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    {:else if langIcon.id === "shell"}
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="currentColor" fill-opacity="0.12" stroke="currentColor" stroke-width="1.1"/>
        <path d="M4.5 6L7 8L4.5 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M8 10H11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
      </svg>
    {:else}
      <!-- Fallback: colored square with extension -->
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
  }
  .icon-image      { color: var(--icon-file-tint, var(--icon-image)); }
  .icon-archive    { color: var(--icon-file-tint, var(--icon-archive)); }
  .icon-code       { color: var(--icon-file-tint, var(--icon-code)); }
  .icon-media      { color: var(--icon-file-tint, var(--icon-media)); }
  .icon-executable { color: var(--icon-file-tint, var(--icon-executable)); }
  .icon-document   { color: var(--icon-file-tint, var(--icon-document)); }

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
