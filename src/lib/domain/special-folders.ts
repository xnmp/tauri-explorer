/**
 * Special folder icons (#1491): well-known directory names (`src`, `tests`,
 * `node_modules`, ...) get a kind, and each icon pack draws that kind in its
 * own idiom. This module is loaded lazily (see
 * `components/icons/special-folder-icons.svelte.ts`) so the alias table and
 * per-pack paint stay out of the startup bundle.
 */
import type { FileEntry } from './file';
import type { IconPack } from './icon-themes';

export type SpecialFolderKind =
  | 'src' | 'lib' | 'app' | 'components' | 'tests' | 'docs' | 'node' | 'git' | 'github'
  | 'vscode' | 'config' | 'scripts' | 'assets' | 'images' | 'public' | 'dist' | 'packages'
  | 'utils' | 'styles' | 'api' | 'types' | 'docker' | 'temp' | 'fonts' | 'audio' | 'video' | 'download';

/**
 * Names are matched case-insensitively. Each kind has artwork in
 * `icons/folder-glyphs/` and a vendored Catppuccin `icons/catppuccin/folder-<kind>.svg`.
 * `hue` is the Material pack's folder colour for the kind.
 */
const KINDS: Readonly<Record<SpecialFolderKind, { names: readonly string[]; hue: string }>> = {
  src: { names: ['src', 'source', 'sources'], hue: '#4caf50' },
  lib: { names: ['lib', 'libs', 'library', 'libraries'], hue: '#afb42b' },
  app: { names: ['app', 'apps'], hue: '#ef5350' },
  components: { names: ['components', 'component', 'widgets'], hue: '#7cb342' },
  tests: { names: ['test', 'tests', '__tests__', '__test__', 'spec', 'specs', 'e2e'], hue: '#00a693' },
  docs: { names: ['doc', 'docs', 'documentation', 'documents'], hue: '#0288d1' },
  node: { names: ['node_modules'], hue: '#8bc34a' },
  git: { names: ['.git'], hue: '#f4511e' },
  github: { names: ['.github'], hue: '#607d8b' },
  vscode: { names: ['.vscode'], hue: '#1e88e5' },
  config: { names: ['config', 'configs', 'configuration', '.config', 'settings'], hue: '#00acc1' },
  scripts: { names: ['scripts', 'script'], hue: '#5c6bc0' },
  assets: { names: ['assets', 'asset', 'resources', 'res'], hue: '#ffa000' },
  images: { names: ['images', 'image', 'img', 'imgs', 'pictures', 'photos', 'screenshots'], hue: '#26a69a' },
  public: { names: ['public', 'static', 'www'], hue: '#039be5' },
  dist: { names: ['dist', 'build', 'out', 'output', 'target'], hue: '#e53935' },
  packages: { names: ['packages', 'crates', 'vendor'], hue: '#8d6e63' },
  utils: { names: ['utils', 'util', 'utilities', 'helpers', 'helper'], hue: '#78909c' },
  styles: { names: ['styles', 'style', 'css', 'scss', 'themes'], hue: '#ec407a' },
  api: { names: ['api', 'apis'], hue: '#fbc02d' },
  types: { names: ['types', 'typings', '@types'], hue: '#1976d2' },
  docker: { names: ['docker', '.docker', '.devcontainer'], hue: '#0097a7' },
  temp: { names: ['temp', 'tmp', 'cache', '.cache'], hue: '#757575' },
  fonts: { names: ['fonts', 'font'], hue: '#e57373' },
  audio: { names: ['music', 'audio', 'sounds', 'sound'], hue: '#ab47bc' },
  video: { names: ['videos', 'video', 'movies'], hue: '#ff7043' },
  download: { names: ['downloads', 'download'], hue: '#43a047' },
};

export const SPECIAL_FOLDER_KINDS = Object.keys(KINDS) as SpecialFolderKind[];

const BY_NAME: ReadonlyMap<string, SpecialFolderKind> = new Map(
  SPECIAL_FOLDER_KINDS.flatMap((kind) => KINDS[kind].names.map((name) => [name, kind] as const)),
);

/** The special kind for a directory name, or null for an ordinary folder. */
export function getSpecialFolderKind(name: string): SpecialFolderKind | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

export function specialFolderHue(kind: SpecialFolderKind): string {
  return KINDS[kind].hue;
}

/**
 * Where a kind's glyph sits, in the icon SVG's viewBox units. `folder` is
 * FolderIcon (18-unit small / 48-unit large), centred on the folder's front
 * panel like the repository emblem so Tiles' bottom-right peek caret stays
 * clear; `catppuccin` places the 16-unit glyph-only symbol (scaled 0.8) on the
 * sprite's outline folder when large, and the full upstream composite when small.
 */
export type SpecialFolderSurface = 'folder' | 'catppuccin';
export interface SpecialFolderGlyphBox { readonly viewBox: number; readonly x: number; readonly y: number; readonly w: number }
export function specialFolderGlyphBox(surface: SpecialFolderSurface, size: 'small' | 'large'): SpecialFolderGlyphBox {
  if (surface === 'catppuccin') return size === 'small' ? { viewBox: 16, x: 0, y: 0, w: 16 } : { viewBox: 16, x: -2.2, y: -0.4, w: 12.8 };
  return size === 'small' ? { viewBox: 18, x: 4.5, y: 6, w: 9 } : { viewBox: 48, x: 15, y: 21.5, w: 18 };
}

/** Everything a renderer needs to draw a special folder in one icon pack. */
export interface SpecialFolderVariant extends SpecialFolderGlyphBox {
  readonly kind: SpecialFolderKind;
  /** Which sprite carries `symbol`. */
  readonly sprite: 'glyphs' | 'catppuccin';
  readonly symbol: string;
  /**
   * Catppuccin small icons replace the whole folder with the upstream
   * composite; every other variant overlays a glyph on the pack's own folder.
   */
  readonly overlay: boolean;
  /** Folder body paint, when the pack recolours the folder (Material). */
  readonly body?: string;
  /** Glyph paint (the sprite's `currentColor`); unset for Catppuccin's own palette. */
  readonly ink?: string;
  /** Glyph stroke width in glyph units: heavier when drawn at 16px. */
  readonly stroke?: number;
}

/**
 * Resolve a directory's special-folder variant for an icon pack. Link and
 * repository decorations take precedence: those folders keep their emblem.
 */
export function resolveSpecialFolderVariant(entry: FileEntry, pack: IconPack, size: 'small' | 'large'): SpecialFolderVariant | null {
  // Mirrors getFolderDecoration without importing it: a static edge to that
  // startup module would split it into its own chunk.
  if (entry.kind !== 'directory' || entry.is_symlink === true || entry.is_git_repo === true) return null;
  const kind = getSpecialFolderKind(entry.name);
  if (!kind) return null;
  if (pack === 'catppuccin') {
    const small = size === 'small';
    return { kind, sprite: 'catppuccin', symbol: small ? `folder-${kind}` : `folder-${kind}-glyph`, overlay: !small, ...specialFolderGlyphBox('catppuccin', size) };
  }
  const box = specialFolderGlyphBox('folder', size);
  const stroke = size === 'small' ? 3 : 2;
  if (pack === 'minimal') return { kind, sprite: 'glyphs', symbol: kind, overlay: true, ink: 'currentColor', stroke: size === 'small' ? 2.6 : 1.6, ...box };
  // Material recolours the folder per kind (honouring a colour theme's file
  // tint, like its file icons); Classic keeps the theme's folder colour. Both
  // draw the glyph as a deeper shade of the body.
  const body = pack === 'material' ? `var(--icon-file-tint, ${KINDS[kind].hue})` : 'var(--icon-folder, #ffb900)';
  return {
    kind, sprite: 'glyphs', symbol: kind, overlay: true, stroke, ...box,
    ...(pack === 'material' ? { body } : {}),
    ink: `color-mix(in srgb, ${body} 40%, #000)`,
  };
}

/**
 * Surfaces that know a folder only by name (#1499: tab bar, sidebar rows,
 * history menu, collapsed preview root) draw a special folder through
 * FileIcon with this synthetic directory entry, so every pack paints its
 * native variant. Null means the host keeps its own folder art: an ordinary
 * name, or a repository the host already marks with its Git styling (#1490).
 */
export function specialFolderIconEntry(name: string, options: { readonly path?: string; readonly repository?: boolean } = {}): FileEntry | null {
  if (options.repository === true || getSpecialFolderKind(name) === null) return null;
  return { name, path: options.path ?? name, kind: 'directory', size: 0, modified: '' };
}
