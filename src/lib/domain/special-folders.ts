/**
 * Special folder icons (#1491): well-known directory names (`src`, `tests`,
 * `node_modules`, ...) get a kind, and each icon pack draws that kind as a
 * corner badge in its own idiom (#1527). This module is loaded lazily (see
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
 * `hue` tints the kind's corner badge in the Classic and Material packs.
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
 * The kind is drawn as a small corner badge (#1527), never by recolouring the
 * folder: the body keeps the theme's folder colour in every pack. The badge
 * sits in the bottom-left corner, the one free of every other decoration
 * (Tiles' peek caret is bottom-right, the Git badge/status letter top-right,
 * the symlink badge top-left). Boxes are in the host icon's viewBox units:
 * `folder` is FolderIcon (18-unit small / 48-unit large), `catppuccin` the
 * 16-unit sprite viewBox. `ring` is the backing's outline width and `glyph`
 * the square the kind's glyph is drawn in, inset from the backing.
 */
export type SpecialFolderSurface = 'folder' | 'catppuccin';
export interface SpecialFolderBadgeBox {
  readonly viewBox: number;
  readonly x: number; readonly y: number; readonly w: number; readonly rx: number; readonly ring: number;
  readonly glyph: { readonly x: number; readonly y: number; readonly w: number };
}
const badgeBox = (viewBox: number, x: number, y: number, w: number, rx: number, ring: number, inset: number): SpecialFolderBadgeBox =>
  ({ viewBox, x, y, w, rx, ring, glyph: { x: x + inset, y: y + inset, w: w - 2 * inset } });
const BADGE_BOXES: Readonly<Record<SpecialFolderSurface, Readonly<Record<'small' | 'large', SpecialFolderBadgeBox>>>> = {
  folder: { small: badgeBox(18, 0.75, 8.25, 9, 2.5, 1, 0.6), large: badgeBox(48, 1.25, 27.75, 19, 5, 1.5, 1.75) },
  catppuccin: { small: badgeBox(16, 0.5, 7.5, 8, 2.2, 0.9, 0.55), large: badgeBox(16, 0.3, 9.2, 6.5, 1.7, 0.4, 0.55) },
};
export function specialFolderBadgeBox(surface: SpecialFolderSurface, size: 'small' | 'large'): SpecialFolderBadgeBox {
  return BADGE_BOXES[surface][size];
}

/**
 * Catppuccin's glyph-only symbols keep the upstream art in the 16-unit box's
 * lower-right quadrant (x 7.5–15.5, y 8.5–15.5); the badge scales this square
 * of the symbol into its glyph box.
 */
export const CATPPUCCIN_GLYPH_CROP = Object.freeze({ x: 7, y: 8, size: 9 });

/** Everything a renderer needs to draw a special folder's badge in one icon pack. */
export interface SpecialFolderVariant {
  readonly kind: SpecialFolderKind;
  /** Which sprite carries `symbol`. */
  readonly sprite: 'glyphs' | 'catppuccin';
  readonly symbol: string;
  readonly box: SpecialFolderBadgeBox;
  /** Backing paint: the theme surface, so the badge reads on any folder colour. */
  readonly fill: string;
  /** Backing outline paint. */
  readonly outline: string;
  /** Glyph paint (the glyph sprite's `currentColor`); unset for Catppuccin's own palette. */
  readonly ink?: string;
  /** Glyph stroke width in the symbol's own units: heavier when drawn at 16px. */
  readonly stroke: number;
}

const BADGE_SURFACE = 'var(--background-solid, #fff)';

/**
 * Resolve a directory's special-folder badge for an icon pack. Link and
 * repository decorations take precedence: those folders keep their emblem.
 */
export function resolveSpecialFolderVariant(entry: FileEntry, pack: IconPack, size: 'small' | 'large'): SpecialFolderVariant | null {
  // Mirrors getFolderDecoration without importing it: a static edge to that
  // startup module would split it into its own chunk.
  if (entry.kind !== 'directory' || entry.is_symlink === true || entry.is_git_repo === true) return null;
  const kind = getSpecialFolderKind(entry.name);
  if (!kind) return null;
  const small = size === 'small';
  if (pack === 'catppuccin') {
    // The glyph keeps its Catppuccin accent; the outline takes the folder's tint.
    return { kind, sprite: 'catppuccin', symbol: `folder-${kind}-glyph`, box: specialFolderBadgeBox('catppuccin', size), fill: BADGE_SURFACE, outline: 'var(--vscode-ctp-text)', stroke: small ? 1.4 : 1 };
  }
  const box = specialFolderBadgeBox('folder', size);
  if (pack === 'minimal') return { kind, sprite: 'glyphs', symbol: kind, box, fill: BADGE_SURFACE, outline: 'currentColor', ink: 'currentColor', stroke: small ? 3 : 2 };
  // Classic and Material tint the badge (never the folder) with the kind's hue,
  // honouring a colour theme's file tint, and pull it toward the theme's text
  // colour so it keeps contrast on light and dark surfaces alike.
  const ink = `color-mix(in srgb, var(--icon-file-tint, ${KINDS[kind].hue}) 70%, var(--text-primary, #000))`;
  return { kind, sprite: 'glyphs', symbol: kind, box, fill: BADGE_SURFACE, outline: ink, ink, stroke: small ? 3.2 : 2.2 };
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
