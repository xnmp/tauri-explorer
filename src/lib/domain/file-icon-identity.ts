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
