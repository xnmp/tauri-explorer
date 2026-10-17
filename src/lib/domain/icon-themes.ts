/** Icon packs are independent of color themes; `default` follows their suggestion. */
export type IconPack = 'material' | 'classic' | 'minimal' | 'catppuccin';
export type IconTheme = IconPack | 'default';

export function resolveIconTheme(choice: IconTheme, suggestion: string): IconPack {
  if (choice !== 'default') return choice;
  const id = suggestion.trim().replace(/^["']|["']$/g, '');
  if (id === 'material' || id === 'minimal' || id === 'classic' || id === 'catppuccin') return id;
  // Existing custom color themes used `default` for the original SVG family.
  return id === 'default' ? 'classic' : 'material';
}
