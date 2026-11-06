/**
 * Plugin file icons (#1523): a plugin names file extensions and supplies SVG
 * artwork for them. The host renders the artwork as an `<img>` data URI, so it
 * can neither run script nor read or restyle the host document.
 * Validation lives in `plugin-contribution-validation.ts`.
 */

export interface FileIconContribution {
  /** `<pluginId>.<name>`. */
  id: string;
  /** Extensions without the dot, e.g. `["rep"]`; matched case-insensitively. */
  extensions: readonly string[];
  /** Self-contained `<svg>` markup with its own colours. */
  svg: string;
  /** Details Type column text for these files, e.g. "StarCraft replay". */
  typeName?: string;
}

/** What the host renders for a matching file. */
export interface ResolvedFileIcon {
  readonly src: string;
  readonly typeName?: string;
}

export const MAX_ICON_SVG_BYTES = 16 * 1024;
