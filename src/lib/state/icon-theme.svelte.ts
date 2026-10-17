import { resolveIconTheme, type IconTheme } from '$lib/domain/icon-themes';
import { settingsStore } from './settings.svelte';
import { themeStore } from './theme.svelte';

/** A picker preview is transient: settings/config/cross-window sync see commits only. */
let preview = $state<IconTheme | null>(null);
const isLight = $derived.by(() => {
  themeStore.appliedThemeRevision;
  return typeof document !== 'undefined' && getComputedStyle(document.documentElement).colorScheme === 'light';
});
const suggestedTheme = $derived.by(() => {
  // CSS reads alone are not reactive. Color-picker previews also change the suggestion.
  themeStore.appliedThemeRevision;
  const suggestion = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue('--theme-icon-pack');
  return resolveIconTheme('default', suggestion);
});
const effectiveTheme = $derived(resolveIconTheme(preview ?? settingsStore.iconTheme, suggestedTheme));

export const iconThemeStore = {
  get currentThemeId() { return settingsStore.iconTheme; },
  get effectiveTheme() { return effectiveTheme; },
  get suggestedTheme() { return suggestedTheme; },
  get isLight() { return isLight; },
  previewTheme(id: IconTheme | null) { preview = id; },
  setTheme(id: IconTheme) { settingsStore.update({iconTheme:id}); preview = null; },
};
