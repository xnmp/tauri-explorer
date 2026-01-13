<!--
  Sidebar component - Windows 11 File Explorer Navigation Pane
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";

  const quickAccessFolders = [
    { name: "Downloads", icon: "download", path: "/home/downloads", pinned: true },
    { name: "Documents", icon: "document", path: "/home/documents", pinned: true },
    { name: "Pictures", icon: "picture", path: "/home/pictures", pinned: true },
    { name: "Videos", icon: "video", path: "/home/videos", pinned: false },
    { name: "Music", icon: "music", path: "/home/music", pinned: false },
  ];

  const drives = [
    { name: "Local Disk (C:)", icon: "drive", path: "/", usage: 65 },
    { name: "Data (D:)", icon: "drive", path: "/data", usage: 42 },
  ];

  let quickAccessExpanded = $state(true);
  let thisPcExpanded = $state(true);
</script>

<div class="sidebar">
  <!-- Home / Gallery / Cloud sections -->
  <div class="nav-section top-section">
    <button class="nav-item" onclick={() => explorer.navigateTo("/home")}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
        <path d="M8 1.5L14.5 7V14C14.5 14.2761 14.2761 14.5 14 14.5H10V10C10 9.72386 9.77614 9.5 9.5 9.5H6.5C6.22386 9.5 6 9.72386 6 10V14.5H2C1.72386 14.5 1.5 14.2761 1.5 14V7L8 1.5Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
      </svg>
      <span>Home</span>
    </button>

    <button class="nav-item" disabled>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
        <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.25"/>
        <path d="M2 6H14M5 3V6M11 3V6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
      <span>Gallery</span>
    </button>

    <button class="nav-item" disabled>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
        <circle cx="8" cy="6" r="3.5" stroke="currentColor" stroke-width="1.25"/>
        <path d="M3 12C3 10 5 8.5 8 8.5C11 8.5 13 10 13 12" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
      <span>OneDrive - Personal</span>
    </button>
  </div>

  <div class="divider"></div>

  <!-- Quick access -->
  <div class="nav-section">
    <button
      class="section-header"
      onclick={() => quickAccessExpanded = !quickAccessExpanded}
      aria-expanded={quickAccessExpanded}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={quickAccessExpanded}>
        <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>Quick access</span>
    </button>

    {#if quickAccessExpanded}
      <div class="section-content">
        {#each quickAccessFolders as folder}
          <button class="nav-item folder-item" onclick={() => explorer.navigateTo(folder.path)}>
            {#if folder.icon === "download"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
                <path d="M8 2V10M8 10L5 7M8 10L11 7M3 12H13" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            {:else if folder.icon === "document"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
                <path d="M4 2C4 1.44772 4.44772 1 5 1H11L15 5V14C15 14.5523 14.5523 15 14 15H5C4.44772 15 4 14.5523 4 14V2Z" stroke="currentColor" stroke-width="1.25"/>
                <path d="M11 1V4C11 4.55228 11.4477 5 12 5H15" stroke="currentColor" stroke-width="1.25"/>
              </svg>
            {:else if folder.icon === "picture"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
                <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" stroke-width="1.25"/>
                <circle cx="5.5" cy="6.5" r="1" fill="currentColor"/>
                <path d="M2 10L5 7L8 10L11 7L14 10V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V10Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
              </svg>
            {:else if folder.icon === "video"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
                <rect x="2" y="4" width="9" height="8" rx="1" stroke="currentColor" stroke-width="1.25"/>
                <path d="M11 7L14 5V11L11 9" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
              </svg>
            {:else if folder.icon === "music"}
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
                <path d="M6 11.5C6 12.3284 5.32843 13 4.5 13C3.67157 13 3 12.3284 3 11.5C3 10.6716 3.67157 10 4.5 10C5.32843 10 6 10.6716 6 11.5ZM6 11.5V3L13 2V9.5M13 9.5C13 10.3284 12.3284 11 11.5 11C10.6716 11 10 10.3284 10 9.5C10 8.67157 10.6716 8 11.5 8C12.3284 8 13 8.67157 13 9.5Z" stroke="currentColor" stroke-width="1.25"/>
              </svg>
            {/if}
            <span>{folder.name}</span>
            {#if folder.pinned}
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="pin-icon">
                <path d="M7 2V5L8 6V8H6.5V11L6 11.5L5.5 11V8H4V6L5 5V2H7Z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
              </svg>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="divider"></div>

  <!-- This PC -->
  <div class="nav-section">
    <button
      class="section-header"
      onclick={() => thisPcExpanded = !thisPcExpanded}
      aria-expanded={thisPcExpanded}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="chevron" class:expanded={thisPcExpanded}>
        <path d="M4 3L7 6L4 9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span>This PC</span>
    </button>

    {#if thisPcExpanded}
      <div class="section-content">
        {#each drives as drive}
          <button class="nav-item drive-item" onclick={() => explorer.navigateTo(drive.path)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="nav-icon">
              <rect x="2" y="4" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.25"/>
              <circle cx="4.5" cy="8" r="0.75" fill="currentColor"/>
              <path d="M2 7H14" stroke="currentColor" stroke-width="1.25"/>
            </svg>
            <div class="drive-details">
              <span class="drive-name">{drive.name}</span>
              <div class="drive-usage">
                <div class="usage-bar">
                  <div class="usage-fill" style="width: {drive.usage}%"></div>
                </div>
              </div>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .sidebar {
    width: 240px;
    background: var(--background-card-secondary);
    border-right: 1px solid var(--divider);
    overflow-y: auto;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
  }

  .nav-section {
    display: flex;
    flex-direction: column;
    padding: 4px;
  }

  .top-section {
    padding-top: 8px;
  }

  .divider {
    height: 1px;
    background: var(--divider);
    margin: 4px 8px;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
    text-align: left;
    width: 100%;
  }

  .section-header:hover {
    background: var(--subtle-fill-secondary);
  }

  .chevron {
    color: var(--text-tertiary);
    transition: transform var(--transition-fast);
  }

  .chevron.expanded {
    transform: rotate(90deg);
  }

  .section-content {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-left: 4px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
    text-align: left;
    width: 100%;
    min-height: 32px;
  }

  .nav-item:hover:not(:disabled) {
    background: var(--subtle-fill-secondary);
  }

  .nav-item:active:not(:disabled) {
    background: var(--subtle-fill-tertiary);
  }

  .nav-item:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .nav-item:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  .nav-icon {
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .folder-item {
    position: relative;
  }

  .pin-icon {
    margin-left: auto;
    opacity: 0.4;
  }

  .drive-item {
    align-items: flex-start;
    padding-top: 8px;
    padding-bottom: 8px;
  }

  .drive-details {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }

  .drive-name {
    font-size: 13px;
  }

  .drive-usage {
    width: 100%;
  }

  .usage-bar {
    height: 3px;
    background: var(--control-fill-tertiary);
    border-radius: 2px;
    overflow: hidden;
  }

  .usage-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }
</style>
