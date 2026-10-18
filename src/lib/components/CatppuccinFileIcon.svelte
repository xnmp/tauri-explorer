<script lang="ts">
  import type { FileEntry } from '$lib/domain/file';
  import { resolveFileIcon, getFolderDecoration } from '$lib/domain/file-icon-identity';
  import { iconThemeStore } from '$lib/state/icon-theme.svelte';
  import spriteUrl from './icons/catppuccin-sprite.svg?url';
  import FolderDecoration from './FolderDecoration.svelte';

  let {entry, size}: {entry: FileEntry; size: 'small' | 'large'} = $props();
  // The external sprite keeps the complete pack out of startup JavaScript.
  const descriptor = $derived(resolveFileIcon(entry));
  const icon = $derived(descriptor.identity);
  const decoration = $derived(getFolderDecoration(entry));
  const category = $derived(descriptor.category);
  const tint=$derived(`var(--icon-file-tint, var(--icon-${category}))`);
</script>

<span class="icon-cat catppuccin-file-icon" class:light={iconThemeStore.isLight} class:git-repo-folder={decoration==='repository'} class:linked-folder={decoration==='linked'} class:icon-html={icon === 'html'} class:icon-video={icon === 'video'} role={icon === 'video' ? 'img' : undefined} aria-label={icon === 'video' ? 'Video' : undefined}
  data-icon-theme="catppuccin" data-icon-id={icon} style:width={`${size === 'small' ? 16 : 64}px`} style:height={`${size === 'small' ? 16 : 64}px`}
  style:--icon-pack-tint={tint} style:--folder-tint={entry.kind === 'directory' ? 'var(--icon-folder, var(--ctp-text))' : undefined}>
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><use href={`${spriteUrl}#${icon}`} width="16" height="16" /></svg>
  {#if decoration !== 'none'}
    <svg class="folder-decoration" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <FolderDecoration {entry} size="large" arrowColor="var(--icon-link-arrow, var(--icon-folder, currentColor))" />
    </svg>
  {/if}
</span>

<style>
  .catppuccin-file-icon {
    display:inline-flex; position:relative; align-items:center; justify-content:center; flex-shrink:0; line-height:0;
    --ctp-blue:#89b4fa; --ctp-sapphire:#74c7ec; --ctp-sky:#89dceb; --ctp-red:#f38ba8; --ctp-peach:#fab387; --ctp-yellow:#f9e2af; --ctp-green:#a6e3a1; --ctp-mauve:#cba6f7; --ctp-pink:#f5c2e7; --ctp-text:#cdd6f4; --ctp-flamingo:#f2cdcd; --ctp-maroon:#eba0ac; --ctp-overlay1:#7f849c;
    --vscode-ctp-blue:var(--icon-pack-tint,var(--ctp-blue)); --vscode-ctp-sapphire:var(--icon-pack-tint,var(--ctp-sapphire)); --vscode-ctp-sky:var(--icon-pack-tint,var(--ctp-sky));
    --vscode-ctp-red:var(--icon-pack-tint,var(--ctp-red)); --vscode-ctp-peach:var(--icon-pack-tint,var(--ctp-peach)); --vscode-ctp-yellow:var(--icon-pack-tint,var(--ctp-yellow));
    --vscode-ctp-green:var(--icon-pack-tint,var(--ctp-green)); --vscode-ctp-mauve:var(--icon-pack-tint,var(--ctp-mauve)); --vscode-ctp-pink:var(--icon-pack-tint,var(--ctp-pink));
    --vscode-ctp-flamingo:var(--icon-pack-tint,var(--ctp-flamingo)); --vscode-ctp-maroon:var(--icon-pack-tint,var(--ctp-maroon)); --vscode-ctp-overlay1:var(--icon-pack-tint,var(--ctp-overlay1));
    --vscode-ctp-text:var(--folder-tint,var(--icon-pack-tint,var(--ctp-text)));
  }
  .catppuccin-file-icon.light {
    --ctp-blue:#1e66f5; --ctp-sapphire:#209fb5; --ctp-sky:#04a5e5; --ctp-red:#d20f39; --ctp-peach:#fe640b; --ctp-yellow:#df8e1d; --ctp-green:#40a02b; --ctp-mauve:#8839ef; --ctp-pink:#ea76cb; --ctp-text:#4c4f69; --ctp-flamingo:#dd7878; --ctp-maroon:#e64553; --ctp-overlay1:#8c8fa1;
  }
  .catppuccin-file-icon :global(svg) { width:100%; height:100%; }
  .folder-decoration { position:absolute; inset:0; }
</style>
