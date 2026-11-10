import type { FileEntry } from './file';
import { getExtension, getFileIconCategory, isVideoMediaFile } from './file-types';

/** Identity selection only. Artwork and paint tokens belong to the renderer. */
export type FileIconIdentity = 'folder'
  | 'typescript' | 'javascript' | 'react-ts' | 'react-js' | 'python' | 'rust' | 'go'
  | 'java' | 'ruby' | 'c' | 'cpp' | 'csharp' | 'swift' | 'kotlin' | 'php' | 'lua'
  | 'html' | 'css' | 'sass' | 'json' | 'yaml' | 'markdown' | 'svelte' | 'vue'
  | 'shell' | 'config' | 'git' | 'docker' | 'image' | 'archive' | 'audio' | 'video'
  | 'pdf' | 'word' | 'spreadsheet' | 'presentation' | 'database' | 'font'
  | 'executable' | 'shortcut' | 'text' | 'code' | 'file';

export type FileIconCategory = 'folder' | 'code' | 'document' | 'image' | 'archive' | 'media' | 'executable';
export interface FileIconDescriptor {
  readonly identity: FileIconIdentity;
  readonly category: FileIconCategory;
}

const CATEGORIES: Readonly<Record<FileIconIdentity, FileIconCategory>> = {
  folder:'folder', typescript:'code', javascript:'code', 'react-ts':'code', 'react-js':'code', python:'code', rust:'code', go:'code',
  java:'code', ruby:'code', c:'code', cpp:'code', csharp:'code', swift:'code', kotlin:'code', php:'code', lua:'code',
  html:'code', css:'code', sass:'code', json:'code', yaml:'code', svelte:'code', vue:'code', shell:'code', config:'code', git:'code', docker:'code', code:'code',
  markdown:'document', pdf:'document', word:'document', spreadsheet:'document', presentation:'document', database:'document', font:'document', shortcut:'document', text:'document', file:'document',
  image:'image', archive:'archive', audio:'media', video:'media', executable:'executable',
};
export const FILE_ICON_IDENTITIES: readonly FileIconIdentity[] = Object.keys(CATEGORIES) as FileIconIdentity[];

/** A linked directory keeps its link identity even when its target is a repository. */
export function getFolderDecoration(entry: FileEntry): 'linked' | 'repository' | 'none' {
  if (entry.kind !== 'directory') return 'none';
  if (entry.is_symlink === true) return 'linked';
  return entry.is_git_repo === true ? 'repository' : 'none';
}

/**
 * How a repository folder is drawn in each icon pack (#1490). Like the pack
 * conventions it imitates (Material's coloured special folders, Catppuccin's
 * tinted outlines), the whole folder takes `--icon-git-badge` and carries a
 * branch glyph on its body, rather than wearing a foreign plate:
 * - `filled` (Material, Classic): solid folder, glyph knocked out in the
 *   window background (`--icon-git-badge-glyph` overrides), so it contrasts
 *   with light accents on dark themes and dark accents on light themes;
 * - `outline` (Minimal, Catppuccin): tinted outline, glyph stroked in the same
 *   colour and the pack's own stroke weight.
 */
export type RepositoryFolderStyle = 'filled' | 'outline';
export function repositoryFolderStyle(pack: 'material' | 'classic' | 'minimal' | 'catppuccin'): RepositoryFolderStyle {
  return pack === 'minimal' || pack === 'catppuccin' ? 'outline' : 'filled';
}

/**
 * The branch glyph's nodes, in glyph units: a trunk with nodes at (-4, ±6) and
 * a branch node at (4, -3) whose line curves into the trunk above its lower
 * node. An original, generic branch mark (not a vendor logo); FolderDecoration
 * draws these three circles.
 */
export const REPOSITORY_GLYPH_NODES = [[-4, -6], [-4, 6], [4, -3]] as const;

/** Glyph lines (glyph units); they stop at ring edges so ringed nodes stay open. */
export function repositoryGlyphPath(e: RepositoryEmblem): string {
  const gap = e.ring ? e.r : 0;
  return `M-4 ${gap - 6}V${6 - gap}M4 ${gap - 3}C4 1.5-4 0-4 2.5`;
}

/**
 * A repository folder's Git glyph in its SVG's square viewBox units. It sits
 * centred on the folder's front panel, never in the bottom-right corner where
 * Tiles' peek caret is drawn (#1477). Surfaces: `folder` = FolderIcon (18-unit
 * small / 48-unit large); `catppuccin` = the 48-unit overlay on the sprite's
 * outline folder, `size` being its rendered size; `thumbnail` = a photo
 * folder's front flap, below its photos. `unit` maps glyph units to viewBox
 * units; `stroke` and `dot` (node circle radius, also stroked) are viewBox
 * units. `ring` nodes are left open (outline packs at legible sizes), others
 * filled. `rotate` lays the glyph on its side on the slim photo-folder flap.
 */
export type RepositoryEmblemSurface = 'folder' | 'catppuccin' | 'thumbnail';
export interface RepositoryEmblem {
  readonly viewBox: number; readonly cx: number; readonly cy: number;
  readonly unit: number; readonly stroke: number; readonly dot: number; readonly ring: boolean; readonly rotate: 0 | -90;
  /** Node radius in glyph units (`dot / unit`). */
  readonly r: number;
}
const emblem = (viewBox: number, cx: number, cy: number, unit: number, stroke: number, dot: number, ring = false, rotate: 0 | -90 = 0): RepositoryEmblem =>
  ({ viewBox, cx, cy, unit, stroke, dot, ring, rotate, r: dot / unit });
export function repositoryEmblem(surface: RepositoryEmblemSurface, size: 'small' | 'large', style: RepositoryFolderStyle = 'filled'): RepositoryEmblem {
  const small = size === 'small', outline = style === 'outline';
  // Catppuccin's sprite strokes 1 of 16 units: 3 overlay units at any size.
  if (surface === 'catppuccin') return small ? emblem(48, 21, 27, 1, 3, 1.9) : emblem(48, 21, 27.25, 1.1, 3, 2.6, true);
  if (surface === 'thumbnail') return emblem(48, 24, 41.6, 0.33, 1.15, 0.72, false, -90);
  if (small) return outline ? emblem(18, 9, 10.5, 0.36, 1, 0.6) : emblem(18, 9, 10.5, 0.37, 1.05, 0.72);
  // Minimal's large outline is 1.5 units; Material/Classic take the 3-unit
  // weight of the Material sprite's own Git mark.
  return outline ? emblem(48, 24, 29.4, 1, 1.5, 2.3, true) : emblem(48, 24, 30.6, 1.05, 3, 1.8);
}

/** The glyph's painted extent in viewBox units, including node radii and strokes. */
export function repositoryEmblemBounds(e: RepositoryEmblem): { left: number; right: number; top: number; bottom: number } {
  const reach = e.dot + e.stroke / 2;
  // rotate(-90) maps glyph (x, y) to (y, -x).
  const turned = REPOSITORY_GLYPH_NODES.map(([x, y]) => e.rotate === -90 ? [y, -x] : [x, y]);
  const xs = turned.map(([x]) => e.cx + x * e.unit);
  const ys = turned.map(([, y]) => e.cy + y * e.unit);
  return { left: Math.min(...xs) - reach, right: Math.max(...xs) + reach, top: Math.min(...ys) - reach, bottom: Math.max(...ys) + reach };
}

/** Tiles' 20px peek caret starts this many px inside the icon's bottom-right (TilePanelsView `.tile-caret`). */
export const TILE_CARET_INSET = Object.freeze({ right: 14, bottom: 17 });

const EXTENSIONS: Readonly<Record<string, FileIconIdentity>> = {
  ts:'typescript', mts:'typescript', cts:'typescript', tsx:'react-ts',
  js:'javascript', mjs:'javascript', cjs:'javascript', jsx:'react-js',
  py:'python', pyw:'python', rs:'rust', go:'go', java:'java', rb:'ruby',
  c:'c', h:'c', cpp:'cpp', cc:'cpp', cxx:'cpp', hpp:'cpp', hxx:'cpp', cs:'csharp',
  swift:'swift', kt:'kotlin', kts:'kotlin', php:'php', lua:'lua',
  html:'html', htm:'html', css:'css', scss:'sass', sass:'sass', less:'css',
  json:'json', jsonc:'json', json5:'json', yaml:'yaml', yml:'yaml',
  md:'markdown', markdown:'markdown', mdx:'markdown', svelte:'svelte', vue:'vue',
  sh:'shell', bash:'shell', zsh:'shell', fish:'shell', ps1:'shell', bat:'shell', cmd:'shell',
  toml:'config', ini:'config', cfg:'config', conf:'config', env:'config', properties:'config',
  jpg:'image', jpeg:'image', png:'image', gif:'image', bmp:'image', svg:'image', webp:'image', ico:'image', icns:'image', avif:'image',
  zip:'archive', rar:'archive', '7z':'archive', tar:'archive', gz:'archive', bz2:'archive', xz:'archive', zst:'archive',
  mp3:'audio', wav:'audio', flac:'audio', ogg:'audio', opus:'audio', aac:'audio', m4a:'audio', m4b:'audio', wma:'audio', aiff:'audio', aif:'audio', alac:'audio',
  pdf:'pdf', doc:'word', docx:'word', odt:'word', rtf:'word',
  xls:'spreadsheet', xlsx:'spreadsheet', ods:'spreadsheet', csv:'spreadsheet', tsv:'spreadsheet',
  ppt:'presentation', pptx:'presentation', odp:'presentation',
  db:'database', sqlite:'database', sqlite3:'database', sql:'database',
  ttf:'font', otf:'font', woff:'font', woff2:'font', exe:'executable', msi:'executable', appimage:'executable', lnk:'shortcut',
  txt:'text', log:'text',
};

const FILENAMES: Readonly<Record<string, FileIconIdentity>> = {
  '.gitignore':'git', '.gitattributes':'git', '.gitmodules':'git',
  '.dockerignore':'docker', dockerfile:'docker', 'docker-compose.yml':'docker', 'docker-compose.yaml':'docker',
  '.env':'config', '.envrc':'config', '.editorconfig':'config', '.npmrc':'config', '.prettierrc':'config', '.eslintrc':'config',
  makefile:'shell', justfile:'shell', procfile:'shell', pkgbuild:'shell',
  gemfile:'ruby', rakefile:'ruby', brewfile:'ruby', license:'text', changelog:'text', authors:'text', codeowners:'text',
};

function identifyFile(entry: FileEntry): FileIconIdentity {
  if (entry.kind === 'directory') return 'folder';
  const name = entry.name.toLowerCase();
  if (Object.hasOwn(FILENAMES, name)) return FILENAMES[name];
  if (name.startsWith('.env.')) return 'config';
  if (isVideoMediaFile(entry)) return 'video';
  const ext = getExtension(entry.name);
  if (Object.hasOwn(EXTENSIONS, ext)) return EXTENSIONS[ext];
  return getFileIconCategory(entry) === 'code' ? 'code' : 'file';
}

/** Resolve identity and paint category together so every alias shares one contract. */
export function resolveFileIcon(entry: FileEntry): FileIconDescriptor {
  const identity = identifyFile(entry);
  return {identity, category:CATEGORIES[identity]};
}
