import type { IconTheme } from '$lib/domain/icon-themes';

/** Presentation choices, loaded with the settings and picker dialogs. */
export const ICON_THEMES = [
  { id: 'material', name: 'Material', description: 'Colorful language logos and file symbols' },
  { id: 'classic', name: 'Classic', description: 'Familiar folders and labeled documents' },
  { id: 'minimal', name: 'Minimal', description: 'Quiet outlines and monochrome file symbols' },
  { id: 'catppuccin', name: 'Catppuccin', description: 'Soft pastel symbols, with light and dark palettes' },
  { id: 'default', name: 'Follow Color Theme', description: 'Use the color theme’s suggested icons; Material otherwise' },
] as const satisfies readonly { id: IconTheme; name: string; description: string }[];
