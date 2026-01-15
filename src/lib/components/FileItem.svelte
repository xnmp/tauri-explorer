<!--
  FileItem component - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-x25
-->
<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { formatSize } from "$lib/domain/file";
  import { explorer } from "$lib/state/explorer.svelte";
  import { moveEntry } from "$lib/api/files";

  interface Props {
    entry: FileEntry;
    onclick: (event: MouseEvent) => void;
    ondblclick: () => void;
    selected?: boolean;
  }

  let { entry, onclick, ondblclick, selected = false }: Props = $props();

  // Inline rename state
  let renameInputRef: HTMLInputElement | null = null;
  let editedName = $state("");
  let renameError = $state<string | null>(null);
  let submittingRename = $state(false);

  // Check if this entry is being renamed
  const isRenaming = $derived(explorer.state.renamingEntry?.path === entry.path);

  // When rename mode starts, initialize and focus the input
  $effect(() => {
    if (isRenaming && renameInputRef) {
      editedName = entry.name;
      renameError = null;
      // Focus and select filename (without extension for files)
      setTimeout(() => {
        renameInputRef?.focus();
        if (entry.kind === "file") {
          const lastDot = entry.name.lastIndexOf(".");
          if (lastDot > 0) {
            renameInputRef?.setSelectionRange(0, lastDot);
          } else {
            renameInputRef?.select();
          }
        } else {
          renameInputRef?.select();
        }
      }, 0);
    }
  });

  async function confirmRename() {
    if (submittingRename) return;

    const trimmedName = editedName.trim();
    if (!trimmedName) {
      renameError = "Name cannot be empty";
      return;
    }

    if (trimmedName === entry.name) {
      explorer.cancelRename();
      return;
    }

    submittingRename = true;
    renameError = null;

    const result = await explorer.rename(trimmedName);

    submittingRename = false;

    if (result) {
      renameError = result;
    }
  }

  function cancelRename() {
    editedName = "";
    renameError = null;
    explorer.cancelRename();
  }

  function handleRenameKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      confirmRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelRename();
    }
  }

  function handleRenameBlur() {
    // Confirm on blur (like Windows Explorer)
    if (editedName.trim() && editedName.trim() !== entry.name) {
      confirmRename();
    } else {
      cancelRename();
    }
  }

  function handleClick(event: MouseEvent) {
    if (isRenaming) {
      event.stopPropagation();
      return;
    }
    onclick(event);
  }

  // Check if this item is in clipboard (for visual feedback)
  const isInClipboard = $derived(
    explorer.state.clipboard?.entry.path === entry.path
  );
  const isCut = $derived(
    isInClipboard && explorer.state.clipboard?.operation === "cut"
  );

  function handleContextMenu(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    explorer.openContextMenu(event.clientX, event.clientY, entry);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (isRenaming) return; // Don't handle item-level shortcuts when renaming

    const hasModifier = event.ctrlKey || event.metaKey;

    const keyActions: Record<string, () => void> = {
      Delete: () => explorer.startDelete(entry),
      F2: () => explorer.startRename(entry),
    };

    const modifierKeyActions: Record<string, () => void> = {
      c: () => explorer.copyToClipboard(entry),
      x: () => explorer.cutToClipboard(entry),
    };

    const action = keyActions[event.key] ?? (hasModifier ? modifierKeyActions[event.key] : undefined);

    if (action) {
      event.preventDefault();
      action();
    }
  }

  // Drag handlers - allow dragging files/folders
  let isDropTarget = $state(false);

  function handleDragStart(event: DragEvent) {
    if (!event.dataTransfer) return;

    // Set drag data with file info
    event.dataTransfer.setData("application/x-explorer-path", entry.path);
    event.dataTransfer.setData("application/x-explorer-name", entry.name);
    event.dataTransfer.setData("application/x-explorer-kind", entry.kind);
    event.dataTransfer.effectAllowed = "move";
  }

  // Drop handlers - allow dropping files/folders into directories
  function handleDragOver(event: DragEvent) {
    // Only accept drops on directories
    if (entry.kind !== "directory") return;
    if (!event.dataTransfer?.types.includes("application/x-explorer-path")) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    isDropTarget = true;
  }

  function handleDragLeave() {
    isDropTarget = false;
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDropTarget = false;

    if (entry.kind !== "directory") return;
    if (!event.dataTransfer) return;

    const sourcePath = event.dataTransfer.getData("application/x-explorer-path");
    if (!sourcePath || sourcePath === entry.path) return;

    // Don't allow moving a folder into itself or its children
    if (entry.path.startsWith(sourcePath + "/")) return;

    const result = await moveEntry(sourcePath, entry.path);
    if (result.ok) {
      // Refresh the file list to reflect the move
      explorer.refresh();
    } else {
      console.error("Failed to move:", result.error);
    }
  }

  // Format modified date - Windows 11 style: M/D/YYYY h:mm AM/PM
  function formatDate(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  // Get descriptive file type from extension - Windows 11 style
  function getFileType(entry: FileEntry): string {
    if (entry.kind === "directory") {
      return "File folder";
    }

    const ext = entry.name.split(".").pop()?.toLowerCase() || "";

    const typeMap: Record<string, string> = {
      // Documents
      txt: "Text Document",
      doc: "Microsoft Word Document",
      docx: "Microsoft Word Document",
      pdf: "Adobe Acrobat Document",
      rtf: "Rich Text Format",
      odt: "OpenDocument Text",

      // Spreadsheets
      xls: "Microsoft Excel Worksheet",
      xlsx: "Microsoft Excel Worksheet",
      csv: "CSV File",
      ods: "OpenDocument Spreadsheet",

      // Presentations
      ppt: "Microsoft PowerPoint Presentation",
      pptx: "Microsoft PowerPoint Presentation",
      odp: "OpenDocument Presentation",

      // Images
      jpg: "JPEG Image",
      jpeg: "JPEG Image",
      png: "PNG Image",
      gif: "GIF Image",
      bmp: "BMP Image",
      svg: "SVG Image",
      webp: "WebP Image",
      ico: "Icon",

      // Archives
      zip: "Compressed (zipped) Folder",
      rar: "WinRAR Archive",
      "7z": "7-Zip Archive",
      tar: "TAR Archive",
      gz: "GZ Archive",

      // Code
      js: "JavaScript File",
      ts: "TypeScript File",
      jsx: "React JavaScript File",
      tsx: "React TypeScript File",
      py: "Python File",
      java: "Java File",
      cpp: "C++ Source File",
      c: "C Source File",
      h: "C/C++ Header File",
      cs: "C# Source File",
      go: "Go Source File",
      rs: "Rust Source File",
      php: "PHP File",
      rb: "Ruby File",
      swift: "Swift Source File",
      kt: "Kotlin Source File",

      // Web
      html: "HTML Document",
      htm: "HTML Document",
      css: "Cascading Style Sheet",
      scss: "SCSS File",
      sass: "Sass File",
      less: "LESS File",
      json: "JSON File",
      xml: "XML Document",
      yaml: "YAML File",
      yml: "YAML File",

      // Executables & Scripts
      exe: "Application",
      msi: "Windows Installer Package",
      bat: "Windows Batch File",
      cmd: "Windows Command Script",
      ps1: "PowerShell Script",
      sh: "Shell Script",
      bash: "Bash Script",

      // System
      dll: "Dynamic Link Library",
      sys: "System File",
      ini: "Configuration Settings",
      cfg: "Configuration File",
      conf: "Configuration File",
      reg: "Registration Entries",

      // Media
      mp3: "MP3 Audio File",
      wav: "WAV Audio File",
      flac: "FLAC Audio File",
      ogg: "OGG Audio File",
      mp4: "MP4 Video",
      avi: "AVI Video",
      mkv: "MKV Video",
      mov: "QuickTime Movie",
      wmv: "Windows Media Video",

      // Fonts
      ttf: "TrueType Font",
      otf: "OpenType Font",
      woff: "Web Open Font Format",
      woff2: "Web Open Font Format 2",

      // Data
      db: "Database File",
      sql: "SQL File",
      sqlite: "SQLite Database",

      // Misc
      md: "Markdown Document",
      log: "Log File",
      tmp: "Temporary File",
    };

    return typeMap[ext] || (ext ? `${ext.toUpperCase()} File` : "File");
  }

  // Get icon color based on file extension - Windows 11 style colors
  function getFileIconColor(entry: FileEntry): string {
    if (entry.kind === "directory") {
      return ""; // Handled by folder-specific styling
    }

    const ext = entry.name.split(".").pop()?.toLowerCase() || "";

    const colorMap: Record<string, string> = {
      // Documents - Blue
      txt: "#2b579a", doc: "#2b579a", docx: "#2b579a", rtf: "#2b579a", odt: "#2b579a",

      // PDF - Red
      pdf: "#d13438",

      // Spreadsheets - Green
      xls: "#217346", xlsx: "#217346", csv: "#217346", ods: "#217346",

      // Presentations - Orange
      ppt: "#d24726", pptx: "#d24726", odp: "#d24726",

      // Images - Teal/Cyan
      jpg: "#008272", jpeg: "#008272", png: "#008272", gif: "#008272",
      bmp: "#008272", svg: "#008272", webp: "#008272", ico: "#008272",

      // Archives - Purple
      zip: "#744da9", rar: "#744da9", "7z": "#744da9", tar: "#744da9", gz: "#744da9",

      // Code - Yellow/Gold
      js: "#f7df1e", ts: "#3178c6", jsx: "#61dafb", tsx: "#3178c6",
      py: "#3776ab", java: "#ed8b00", cpp: "#659ad2", c: "#a8b9cc",
      h: "#a8b9cc", cs: "#68217a", go: "#00add8", rs: "#dea584",
      php: "#777bb4", rb: "#cc342d", swift: "#f05138", kt: "#7f52ff",

      // Web - Orange/Blue
      html: "#e44d26", htm: "#e44d26", css: "#264de4", scss: "#cf649a",
      sass: "#cf649a", less: "#1d365d", json: "#f5a623", xml: "#f16529",
      yaml: "#cb171e", yml: "#cb171e",

      // Executables - Gray/Blue
      exe: "#0078d4", msi: "#0078d4", bat: "#4d4d4d", cmd: "#4d4d4d",
      ps1: "#012456", sh: "#4eaa25", bash: "#4eaa25",

      // System - Gray
      dll: "#6d6d6d", sys: "#6d6d6d", ini: "#6d6d6d", cfg: "#6d6d6d",
      conf: "#6d6d6d", reg: "#0078d4",

      // Media - Pink/Purple
      mp3: "#f472b6", wav: "#f472b6", flac: "#f472b6", ogg: "#f472b6",
      mp4: "#a855f7", avi: "#a855f7", mkv: "#a855f7", mov: "#a855f7", wmv: "#a855f7",

      // Fonts - Gray
      ttf: "#6d6d6d", otf: "#6d6d6d", woff: "#6d6d6d", woff2: "#6d6d6d",

      // Data - Teal
      db: "#0d9488", sql: "#0d9488", sqlite: "#0d9488",

      // Misc
      md: "#083fa1", log: "#6d6d6d", tmp: "#9ca3af",
    };

    return colorMap[ext] || "#6d6d6d"; // Default gray
  }

  // Get file icon category for different SVG paths
  type IconCategory = "document" | "image" | "archive" | "code" | "media" | "executable" | "default";

  function getFileIconCategory(entry: FileEntry): IconCategory {
    if (entry.kind === "directory") return "default";

    const ext = entry.name.split(".").pop()?.toLowerCase() || "";

    const categories: Record<string, IconCategory> = {
      // Documents
      txt: "document", doc: "document", docx: "document", pdf: "document",
      rtf: "document", odt: "document", xls: "document", xlsx: "document",
      csv: "document", ods: "document", ppt: "document", pptx: "document",
      odp: "document", md: "document",

      // Images
      jpg: "image", jpeg: "image", png: "image", gif: "image",
      bmp: "image", svg: "image", webp: "image", ico: "image",

      // Archives
      zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive",

      // Code
      js: "code", ts: "code", jsx: "code", tsx: "code", py: "code",
      java: "code", cpp: "code", c: "code", h: "code", cs: "code",
      go: "code", rs: "code", php: "code", rb: "code", swift: "code",
      kt: "code", html: "code", htm: "code", css: "code", scss: "code",
      sass: "code", less: "code", json: "code", xml: "code", yaml: "code",
      yml: "code", sql: "code",

      // Media
      mp3: "media", wav: "media", flac: "media", ogg: "media",
      mp4: "media", avi: "media", mkv: "media", mov: "media", wmv: "media",

      // Executables
      exe: "executable", msi: "executable", bat: "executable", cmd: "executable",
      ps1: "executable", sh: "executable", bash: "executable",
    };

    return categories[ext] || "default";
  }
</script>

<button
  class="file-item"
  class:directory={entry.kind === "directory"}
  class:cut={isCut}
  class:in-clipboard={isInClipboard}
  class:selected
  class:drop-target={isDropTarget}
  onclick={handleClick}
  {ondblclick}
  oncontextmenu={handleContextMenu}
  onkeydown={handleKeydown}
  draggable="true"
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <!-- Name column -->
  <div class="name-cell">
    <div class="icon" aria-hidden="true">
      {#if entry.kind === "directory"}
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M2 5.5C2 4.67157 2.67157 4 3.5 4H6.17157C6.43679 4 6.69114 4.10536 6.87868 4.29289L7.5 4.91421L8.12132 4.29289C8.30886 4.10536 8.56321 4 8.82843 4H13C13.8284 4 14.5 4.67157 14.5 5.5V6H15.5V5.5C15.5 4.11929 14.3807 3 13 3H8.82843C8.29799 3 7.78929 3.21071 7.41421 3.58579L7.5 3.67157L7.58579 3.58579C7.21071 3.21071 6.70201 3 6.17157 3H3.5C2.11929 3 1 4.11929 1 5.5V12.5C1 13.8807 2.11929 15 3.5 15H8V14H3.5C2.67157 14 2 13.3284 2 12.5V5.5Z"
            fill="currentColor"
            class="folder-back"
          />
          <path
            d="M2.5 7.5C2.5 6.94772 2.94772 6.5 3.5 6.5H14.5C15.0523 6.5 15.5 6.94772 15.5 7.5V12.5C15.5 13.6046 14.6046 14.5 13.5 14.5H4.5C3.39543 14.5 2.5 13.6046 2.5 12.5V7.5Z"
            fill="currentColor"
            class="folder-front"
          />
        </svg>
      {:else}
        {@const iconColor = getFileIconColor(entry)}
        {@const iconCategory = getFileIconCategory(entry)}
        {#if iconCategory === "image"}
          <!-- Image file icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect x="3" y="3" width="12" height="12" rx="1.5" fill={iconColor} fill-opacity="0.15"/>
            <rect x="3" y="3" width="12" height="12" rx="1.5" stroke={iconColor} stroke-width="1.25"/>
            <circle cx="6.5" cy="6.5" r="1.5" fill={iconColor}/>
            <path d="M3 12L6 9L8.5 11.5L11 8L15 12V13.5C15 14.3284 14.3284 15 13.5 15H4.5C3.67157 15 3 14.3284 3 13.5V12Z" fill={iconColor} fill-opacity="0.4"/>
          </svg>
        {:else if iconCategory === "archive"}
          <!-- Archive file icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M4 3C4 2.44772 4.44772 2 5 2H13C13.5523 2 14 2.44772 14 3V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" fill={iconColor} fill-opacity="0.15"/>
            <path d="M4 3C4 2.44772 4.44772 2 5 2H13C13.5523 2 14 2.44772 14 3V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke={iconColor} stroke-width="1.25"/>
            <rect x="7" y="4" width="4" height="2" rx="0.5" fill={iconColor}/>
            <rect x="7" y="7" width="4" height="2" rx="0.5" fill={iconColor}/>
            <rect x="7" y="10" width="4" height="3" rx="0.5" fill={iconColor}/>
          </svg>
        {:else if iconCategory === "code"}
          <!-- Code file icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M4 3C4 2.44772 4.44772 2 5 2H10L14 6V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" fill={iconColor} fill-opacity="0.15"/>
            <path d="M4 3C4 2.44772 4.44772 2 5 2H10L14 6V15C14 15.5523 13.5523 16 13 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke={iconColor} stroke-width="1.25"/>
            <path d="M10 2V5C10 5.55228 10.4477 6 11 6H14" stroke={iconColor} stroke-width="1.25"/>
            <path d="M7.5 9L6 10.5L7.5 12M10.5 9L12 10.5L10.5 12" stroke={iconColor} stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {:else if iconCategory === "media"}
          <!-- Media file icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect x="3" y="4" width="12" height="10" rx="1.5" fill={iconColor} fill-opacity="0.15"/>
            <rect x="3" y="4" width="12" height="10" rx="1.5" stroke={iconColor} stroke-width="1.25"/>
            <path d="M7 7V11L11 9L7 7Z" fill={iconColor}/>
          </svg>
        {:else if iconCategory === "executable"}
          <!-- Executable file icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect x="3" y="3" width="12" height="12" rx="2" fill={iconColor} fill-opacity="0.15"/>
            <rect x="3" y="3" width="12" height="12" rx="2" stroke={iconColor} stroke-width="1.25"/>
            <path d="M6 9H12M9 6V12" stroke={iconColor} stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        {:else}
          <!-- Default document icon -->
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M4 3C4 2.44772 4.44772 2 5 2H10L15 7V15C15 15.5523 14.5523 16 14 16H5C4.44772 16 4 15.5523 4 15V3Z" fill={iconColor} fill-opacity="0.15"/>
            <path d="M4 3C4 2.44772 4.44772 2 5 2H10L15 7V15C15 15.5523 14.5523 16 14 16H5C4.44772 16 4 15.5523 4 15V3Z" stroke={iconColor} stroke-width="1.25"/>
            <path d="M10 2V6C10 6.55228 10.4477 7 11 7H15" stroke={iconColor} stroke-width="1.25"/>
            <path d="M6.5 10H11.5M6.5 12.5H10" stroke={iconColor} stroke-width="1" stroke-linecap="round"/>
          </svg>
        {/if}
      {/if}
    </div>
    {#if isRenaming}
      <!-- svelte-ignore a11y_autofocus -->
      <input
        type="text"
        class="rename-input"
        class:error={!!renameError}
        bind:value={editedName}
        bind:this={renameInputRef}
        onkeydown={handleRenameKeydown}
        onblur={handleRenameBlur}
        onclick={(e) => e.stopPropagation()}
        disabled={submittingRename}
        autofocus
      />
    {:else}
      <span class="name">{entry.name}</span>
    {/if}
    {#if isInClipboard && !isRenaming}
      <div class="clipboard-badge" aria-label={isCut ? "Cut" : "Copied"}>
        {#if isCut}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M3 2L1.5 3.5L3 5M7 2L8.5 3.5L7 5M2 3.5H8" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {:else}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2.5 2.5H7.5M2.5 2.5V7.5C2.5 7.77614 2.72386 8 3 8H7C7.27614 8 7.5 7.77614 7.5 7.5V2.5M2.5 2.5L3 1.5H7L7.5 2.5M4.5 4.5V6M5.5 4.5V6" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Date modified column -->
  <div class="date-cell">
    {formatDate(entry.modified)}
  </div>

  <!-- Type column -->
  <div class="type-cell">
    {getFileType(entry)}
  </div>

  <!-- Size column -->
  <div class="size-cell">
    {#if entry.kind === "file"}
      {formatSize(entry.size)}
    {:else}
      <span class="empty-cell">—</span>
    {/if}
  </div>
</button>

<style>
  .file-item {
    display: grid;
    grid-template-columns: 1fr 180px 160px 100px;
    gap: 8px;
    align-items: center;
    padding: 4px 16px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    width: 100%;
    font-family: inherit;
    color: var(--text-primary);
    transition: all var(--transition-fast);
    position: relative;
    min-height: 32px;
  }

  .file-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .file-item:active {
    background: var(--subtle-fill-tertiary);
  }

  .file-item:focus-visible {
    outline: none;
    border-color: var(--accent);
    background: var(--subtle-fill-secondary);
    box-shadow: 0 0 0 1px var(--accent);
  }

  /* Selected state */
  .file-item.selected {
    background: var(--subtle-fill-secondary);
    border-color: var(--accent);
  }

  .file-item.selected:hover {
    background: var(--subtle-fill-tertiary);
  }

  /* Cut items appear faded */
  .file-item.cut {
    opacity: 0.5;
  }

  .file-item.in-clipboard:not(.cut) {
    background: linear-gradient(135deg, rgba(0, 120, 212, 0.06), rgba(0, 120, 212, 0.02));
    border-color: rgba(0, 120, 212, 0.2);
  }

  /* Name cell */
  .name-cell {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  /* Icon container */
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }

  /* Folder colors - Windows 11 vibrant golden yellow */
  .folder-back {
    opacity: 0.65;
  }

  .folder-front {
    opacity: 1;
  }

  .directory .icon {
    color: #ffb900;
  }

  .file-item:not(.directory) .icon {
    color: var(--text-secondary);
  }

  /* Name */
  .name {
    font-size: 13px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  /* Inline rename input */
  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    font-size: 13px;
    font-family: inherit;
    font-weight: 400;
    color: var(--text-primary);
    background: var(--control-fill);
    border: 1px solid var(--accent);
    border-radius: 3px;
    outline: none;
    box-shadow: 0 0 0 1px var(--accent);
  }

  .rename-input:focus {
    background: var(--control-fill-secondary);
  }

  .rename-input:disabled {
    opacity: 0.6;
  }

  .rename-input.error {
    border-color: var(--system-critical);
    box-shadow: 0 0 0 1px var(--system-critical);
  }

  /* Date, Type, Size cells */
  .date-cell,
  .type-cell,
  .size-cell {
    font-size: 13px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size-cell {
    text-align: right;
    padding-right: 8px;
  }

  .empty-cell {
    opacity: 0.3;
  }

  /* Clipboard badge */
  .clipboard-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: var(--accent);
    color: var(--text-on-accent);
    border-radius: 3px;
    flex-shrink: 0;
  }

  .file-item.cut .clipboard-badge {
    background: var(--system-caution);
  }

  /* Drop target state - for drag-to-move */
  .file-item.drop-target {
    background: rgba(0, 120, 212, 0.15);
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  /* Dark mode folder color adjustment */
  @media (prefers-color-scheme: dark) {
    .directory .icon {
      color: #ffc83d;
    }

    .file-item:not(.directory) .icon {
      color: var(--text-tertiary);
    }
  }
</style>
