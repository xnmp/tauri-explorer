import { describe, it, expect } from 'vitest';
import { resolveFileIcon, getFolderDecoration } from '$lib/domain/file-icon-identity';
import type { FileEntry } from '$lib/domain/file';
import { FILE_ICON_EXAMPLES } from '../fixtures/file-icon-examples';
const file=(name:string, kind:FileEntry['kind']='file'):FileEntry=>({name,kind,path:`/test/${name}`,size:0,modified:''});

describe('Material icon identity',()=>{
  it.each(FILE_ICON_EXAMPLES)('resolves %s to %s',(name,identity)=>expect(resolveFileIcon(file(name)).identity).toBe(identity));
  it.each([
    ['main.ts','typescript'],['MAIN.MTS','typescript'],['App.tsx','react-ts'],['App.jsx','react-js'],['main.cjs','javascript'],
    ['app.svelte','svelte'],['app.vue','vue'],['styles.scss','sass'],['data.jsonc','json'],['config.toml','config'],
    ['header.hpp','cpp'],['main.c','c'],['song.opus','audio'],['song.m4a','audio'],['movie.WEBM','video'],
    ['files.tar.xz','archive'],['font.woff2','font'],['report.pdf','pdf'],['budget.csv','spreadsheet'],['slides.odp','presentation'],
    ['data.sqlite3','database'],['game.lnk','shortcut'],['program.exe','executable'],
  ])('identifies %s as %s',(name,icon)=>expect(resolveFileIcon(file(name)).identity).toBe(icon));
  it('prefers known filenames and environment variants over extensions',()=>{
    expect(resolveFileIcon(file('.gitignore')).identity).toBe('git');
    expect(resolveFileIcon(file('Dockerfile')).identity).toBe('docker');
    expect(resolveFileIcon(file('docker-compose.yml')).identity).toBe('docker');
    expect(resolveFileIcon(file('.env.production.local')).identity).toBe('config');
  });
  it('does not mistake directories, dotfiles, empty or unknown names for languages',()=>{
    for(const name of ['', '.ts','constructor','__proto__','mystery.unknown','x.'+ 'x'.repeat(10000)]) expect(resolveFileIcon(file(name)).identity).toBe('file');
    expect(resolveFileIcon(file('main.ts','directory'))).toEqual({identity:'folder',category:'folder'});
  });
  it.each([['a.ts','a.mts'],['a.js','a.cjs'],['a.json','a.jsonc'],['a.zip','a.bz2'],['a.mp3','a.opus'],['a.docx','a.odt']])('keeps alias %s and %s in the same paint category',(a,b)=>{
    expect(resolveFileIcon(file(a))).toEqual(resolveFileIcon(file(b)));
  });
  it('keeps linked-directory identity ahead of repository decoration and rejects file flags',()=>{
    expect(getFolderDecoration({...file('repo','directory'),is_git_repo:true})).toBe('repository');
    expect(getFolderDecoration({...file('linked','directory'),is_git_repo:true,is_symlink:true})).toBe('linked');
    expect(getFolderDecoration({...file('not-a-folder'),is_git_repo:true,is_symlink:true})).toBe('none');
  });
});
